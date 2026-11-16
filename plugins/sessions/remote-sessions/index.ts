import type { PluginContext, PluginModule, Subscription } from '@cyborg-harness/contracts';
import type { ProjectSettings, SettingsSection, SettingsValues } from '@cyborg-plugins/contracts';
import { makeAgent } from './agent.ts';
import type { ProjectView } from './args.ts';
import { collectGitAuth, type CliRunner } from './auth.ts';
import { ASSETS } from './assets.generated.ts';
import { hostProblems, readHosts, splitList, validateHosts } from './hosts.ts';
import { Host } from './host.ts';
import { bundleOf, type AgentdBundle } from './install.ts';
import { RemoteService } from './service.ts';
import { Ssh } from './ssh.ts';
import { ClaudeTokenStore } from './token.ts';

export { NO_TARGET_SCRIPT } from './agent.ts';

/** Каналы владельца ai-cyborg -> команды плагина; тест соответствия сверяет их с манифестом. */
export const CHANNELS = {
  'remote:create': 'remote-sessions.create',
  'remote:discover': 'remote-sessions.discover',
  'remote:fs': 'remote-sessions.fs',
  'remote:search': 'remote-sessions.search',
  'remote:wake': 'remote-sessions.wake',
  'remote:remove-asleep': 'remote-sessions.remove-asleep',
  'remote:disk': 'remote-sessions.disk',
  'remote:purge': 'remote-sessions.purge',
  'remote:claude-token:status': 'remote-sessions.claude-token.status',
  'remote:claude-token:set': 'remote-sessions.claude-token.set',
  'remote:claude-token:clear': 'remote-sessions.claude-token.clear',
  'history:remote': 'remote-sessions.history',
} as const;

const SECTION: SettingsSection = {
  id: 'ssh',
  title: 'Удалённые хосты (SSH)',
  order: 300,
  fields: [
    {
      id: 'hosts',
      kind: 'list',
      label: 'Хосты',
      placeholder: 'dev1, build-box',
      hint: 'Алиасы из ~/.ssh/config, до 32 через запятую. Сессия клонирует репозитории проекта на хост и запускает там claude; вход по ключу через ssh-agent, без пароля.',
    },
  ],
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const plugin: PluginModule = {
  config: { defaults: { hosts: {} } },
  state: { defaults: {} },
  async activate(ctx: PluginContext) {
    const { config, state } = ctx;
    // Разделы объявлены манифестом; без них (среда без хранилища слоёв) хосты и экземпляр живут в памяти до выгрузки.
    const memory: { hosts: Record<string, unknown> } = { hosts: {} };
    const hostsDoc = (): unknown => (config ? config.get().hosts : memory.hosts);
    const process = ctx.os.process;
    if (!process || !ctx.os.env) throw new Error('нет права process или env: проверьте манифест');
    const run = process.run.bind(process);

    // Хосты проектов: раздел config, слой воркспейса, `hosts: { <id проекта>: [алиасы] }`.
    const hostsOf = (projectId: string): string[] => {
      const all = hostsDoc();
      return isRecord(all) ? readHosts(all[projectId]) : [];
    };
    const allHosts = (): string[] => {
      const all = hostsDoc();
      return isRecord(all) ? [...new Set(Object.values(all).flatMap(readHosts))] : [];
    };

    // Экземпляр Cyborg: то же окно после обрыва забирает свои сессии у демона. Хранится в state, чтобы пережить перезапуск.
    const stored = state?.get().instance;
    let instance: string = typeof stored === 'string' && /^[0-9a-f-]{36}$/.test(stored) ? stored : '';
    if (!instance) {
      instance = crypto.randomUUID();
      await state?.set('workspace', { instance });
    }

    const env = async (): Promise<Record<string, string>> => {
      const sock = await ctx.os.env?.get('SSH_AUTH_SOCK');
      return sock ? { SSH_AUTH_SOCK: sock } : {};
    };
    const ssh = new Ssh(run, env);
    const tokenStore = new ClaudeTokenStore(ctx.os.secrets);
    const bundle: AgentdBundle = await bundleOf(ASSETS['agentd/agentd.js'] ?? '', ASSETS['agentd/client.js'] ?? '');

    const hosts = new Map<string, Host>();
    const hostFor = (alias: string): Host => {
      let host = hosts.get(alias);
      if (!host) {
        host = new Host({ host: alias, ssh, bundle, instance, claudeToken: async () => (await tokenStore.get()) !== null });
        hosts.set(alias, host);
      }
      return host;
    };

    const projectsContract = (): ReturnType<typeof ctx.contracts.get<'cyborg.projects', 1>> => ctx.contracts.get('cyborg.projects', 1);
    const projectView = async (projectId: string): Promise<ProjectView | undefined> => {
      const found = (await projectsContract()?.list())?.find((p) => p.id === projectId);
      return found ? { repos: found.repos, hosts: hostsOf(projectId) } : undefined;
    };
    const projectOf = async (cwd: string): Promise<ProjectView | undefined> => {
      const found = (await projectsContract()?.list())?.find((p) => p.repos.some((r) => cwd === r || cwd.startsWith(`${r}/`)));
      return found ? { repos: found.repos, hosts: hostsOf(found.id) } : undefined;
    };

    const cli: CliRunner = async (cmd, args) => {
      const res = await run(cmd, args, { timeoutMs: 20_000 });
      return { code: res.code, stdout: res.stdout };
    };
    const service = new RemoteService({
      host: hostFor,
      project: projectView,
      originUrl: async (dir) => {
        const res = await run('git', ['remote', 'get-url', 'origin'], { cwd: dir, timeoutMs: 20_000 }).catch(() => undefined);
        const url = res?.code === 0 ? res.stdout.trim() : '';
        return url || null;
      },
      gitAuth: (urls) => collectGitAuth(urls, cli),
      claudeToken: () => tokenStore.get(),
      uuid: () => crypto.randomUUID(),
      secret: () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join(''),
    });

    // cyborg.agent: запуск ssh в pty потребителя.
    const agent = makeAgent({
      ssh,
      service,
      host: hostFor,
      bundle: () => bundle,
      instance,
      allowedHost: (alias) => Promise.resolve(allHosts().includes(alias)),
      projectOf,
      sshVersion: async () => {
        const res = await run('ssh', ['-V'], { timeoutMs: 10_000 }).catch(() => undefined);
        return res ? `${res.stdout}\n${res.stderr}` : undefined;
      },
      env,
    });
    ctx.subscriptions.add(ctx.contracts.provide('cyborg.agent', '1.0', agent));

    // cyborg.project-settings: секция «Удалённые хосты (SSH)» формы свойств проекта.
    const listeners = new Set<(projectId: string) => void>();
    const settings: ProjectSettings = {
      section: async () => SECTION,
      load: async (projectId) => ({ hosts: projectId === null ? [] : hostsOf(projectId) }),
      validate: async (_projectId, values) => hostProblems(values.hosts),
      save: async (projectId, values: SettingsValues) => {
        const list = typeof values.hosts === 'string' ? splitList(values.hosts) : values.hosts;
        const checked = validateHosts(list);
        if (checked === null) throw new Error(hostProblems(list).join('; ') || 'хосты не годятся');
        const current = hostsDoc();
        const all: Record<string, unknown> = isRecord(current) ? { ...current } : {};
        if (checked.length > 0) all[projectId] = checked;
        else delete all[projectId];
        if (config) await config.set('workspace', { hosts: all });
        else memory.hosts = all;
        for (const l of listeners) l(projectId);
      },
      onChange: (listener): Subscription => {
        listeners.add(listener);
        return { dispose: () => void listeners.delete(listener) };
      },
    };
    ctx.subscriptions.add(ctx.contracts.provide('cyborg.project-settings', '1.0', settings));

    const reg = (name: string, handler: (...args: unknown[]) => unknown): void => void ctx.subscriptions.add(ctx.commands.register(name, handler));
    reg('remote-sessions.create', (projectId, args) => service.create(projectId, args));
    reg('remote-sessions.create-task', (projectId, args) => service.createWithPrompt(projectId, args));
    reg('remote-sessions.discover', (projectId) => service.discover(projectId));
    reg('remote-sessions.history', (projectId) => service.history(projectId));
    reg('remote-sessions.wake', (projectId, host, sid) => service.wake(projectId, host, sid));
    reg('remote-sessions.remove-asleep', (projectId, host, sid) => service.removeAsleep(projectId, host, sid));
    reg('remote-sessions.disk', (projectId, host) => service.disk(projectId, host));
    reg('remote-sessions.purge', (projectId, host, sids, force) => service.purge(projectId, host, sids, force));
    reg('remote-sessions.close', (resumeId, keep) => service.close(resumeId, keep));
    reg('remote-sessions.fs', (resumeId, op, path) => service.fs(resumeId, op, path));
    reg('remote-sessions.search', (resumeId, mode, request) => service.search(resumeId, mode, request));
    reg('remote-sessions.claude-token.status', () => tokenStore.status());
    reg('remote-sessions.claude-token.set', (token) => tokenStore.set(token));
    reg('remote-sessions.claude-token.clear', () => tokenStore.clear());
    ctx.log(`удалённые сессии: демон ${bundle.version}, экземпляр ${instance.slice(0, 8)}`);
    return undefined;
  },
};

export default plugin;
