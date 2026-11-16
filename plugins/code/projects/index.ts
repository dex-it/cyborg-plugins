import type { PluginContext, PluginModule, Provider, Remote, Subscription } from '@cyborg-harness/contracts';
import type { ProjectInfo, ProjectSettings, Projects, ProjectsChange, SettingsSection, SettingsValues } from '@cyborg-plugins/contracts';
import { isInside, isPlainPath, problemFromRefusal, readProjects, validateProjectsState, type Project, type ProjectsProblem } from './model.ts';
import { treeRoots } from './roots.ts';
import { projectsProblemText } from './text.ts';

// Плагин projects: проекты воркспейса (набор локальных репозиториев под одним именем), выбранный проект, выбор каталога и корни для остальных плагинов.
// Данные: раздел config `settings.projects` (слой воркспейса, `items`) и раздел state (`lastProjectId`). Прежний ProjectStore ai-cyborg (файл, замок, копия .corrupt)
// ушёл в ядро: файл воркспейса читает и пишет оно, плагин только отвечает за свой раздел.
// Каналы владельца ai-cyborg -> команды: dialog:pickDir -> projects.pick-dir, projects:load -> projects.load, projects:problem -> projects.problem,
// projects:save -> projects.save, project:selected -> projects.select (и члены контракта cyborg.projects: selected, hasSelected, onChange).

/** Соответствие каналов владельца командам плагина; тест соответствия сверяет его с манифестом и проверяет ответы. */
export const CHANNELS = {
  'dialog:pickDir': 'projects.pick-dir',
  'projects:load': 'projects.load',
  'projects:problem': 'projects.problem',
  'projects:save': 'projects.save',
  'project:selected': 'projects.select',
} as const;

/** Что вид получает от `projects.load` и после `projects.save`. */
export interface LoadReply {
  readonly projects: ProjectInfo[];
  readonly lastProjectId: string | null;
  readonly problem: ProblemReply | null;
}

export interface ProblemReply extends ProjectsProblem {
  readonly text: string;
}

/** Что форма свойств получает от `projects.form`. */
export interface FormReply {
  readonly project: ProjectInfo | null;
  readonly state: { readonly projects: ProjectInfo[]; readonly lastProjectId: string | null };
  readonly sections: readonly { readonly provider: string; readonly section: SettingsSection; readonly values: SettingsValues }[];
  readonly problem: ProblemReply | null;
}

type Settings = Remote<ProjectSettings>;
interface Loaded {
  readonly provider: Provider<Settings>;
  readonly section: SettingsSection;
}

const info = (p: Project): ProjectInfo => ({ id: p.id, name: p.name, description: p.description, repos: [...p.repos] });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const plugin: PluginModule = {
  config: { defaults: { items: [] } },
  state: { defaults: { lastProjectId: null } },
  activate(ctx: PluginContext) {
    const { config: maybeConfig, state: maybeState } = ctx;
    if (!maybeConfig || !maybeState) throw new Error('нет разделов config и state: проверьте манифест');
    const config = maybeConfig;
    const state = maybeState;

    let projects: Project[] = readProjects(config.get());
    let selectedId: string | null = null;
    const savedLast = state.get().lastProjectId;
    if (typeof savedLast === 'string' && projects.some((p) => p.id === savedLast)) selectedId = savedLast;
    /** Каталоги, выбранные человеком в диалоге в этом запуске: доступны остальным плагинам до сохранения проекта. */
    const picked = new Set<string>();
    let rejected: string[] = [];
    let problem: ProjectsProblem | null = null;
    const listeners = new Set<(change: ProjectsChange) => void>();

    const emit = (change: ProjectsChange): void => {
      for (const listener of [...listeners]) {
        try {
          listener(change);
        } catch (error) {
          ctx.log(`слушатель projects.onChange: ${messageOf(error)}`, 'warn');
        }
      }
    };
    const tell = (): void => void ctx.views.channel('projects').post({ changed: true }).catch(() => undefined);

    const currentProblem = (): ProblemReply | null => {
      const found: ProjectsProblem | null =
        problem ?? (rejected.length > 0 ? { kind: 'roots', detail: `ядро не приняло каталоги как корни: ${rejected.join(', ')}; выберите каталог кнопкой «Папка…», чтобы подтвердить его` } : null);
      return found && { ...found, text: projectsProblemText(found, null) };
    };
    const snapshot = (): LoadReply => ({ projects: projects.map(info), lastProjectId: selectedId, problem: currentProblem() });

    /** Корни всех проектов и выбранные каталоги - ядру: область `workspace` для остальных плагинов. Негодный корень не лишает остальные. */
    async function publishRoots(): Promise<void> {
      const security = ctx.os.security;
      if (!security) return;
      const wanted = [...new Set([...projects.flatMap((p) => p.repos), ...picked])];
      try {
        await security.setRoots(wanted);
        rejected = [];
        return;
      } catch {
        // Один корень не принят (не каталог, назван только в файле воркспейса): принимаем по одному, чтобы он не закрыл остальные.
      }
      const accepted: string[] = [];
      rejected = [];
      for (const root of wanted) {
        try {
          await security.setRoots([root]);
          accepted.push(root);
        } catch {
          rejected.push(root);
        }
      }
      await security.setRoots(accepted);
    }

    /** Физический путь (FR-5007): git и Claude Code называют репозиторий им; нет каталога или путь вне областей - остаётся как задан. */
    const canonical = async (dir: string): Promise<string> => {
      try {
        return await ctx.os.fs.realpath(dir);
      } catch {
        return dir;
      }
    };

    const diff = (prev: readonly Project[], next: readonly Project[]): ProjectsChange[] => {
      const before = new Map(prev.map((p) => [p.id, p]));
      const after = new Map(next.map((p) => [p.id, p]));
      const out: ProjectsChange[] = [];
      for (const p of next) {
        const old = before.get(p.id);
        if (!old) out.push({ type: 'added', projectId: p.id });
        else if (JSON.stringify(old) !== JSON.stringify(p)) out.push({ type: 'updated', projectId: p.id });
      }
      for (const p of prev) if (!after.has(p.id)) out.push({ type: 'removed', projectId: p.id });
      return out;
    };

    const setSelected = async (id: string | null): Promise<void> => {
      if (id === selectedId) return;
      selectedId = id;
      try {
        await state.set('workspace', { lastProjectId: id });
      } catch (error) {
        ctx.log(`выбранный проект не записан: ${messageOf(error)}`, 'warn');
      }
      emit({ type: 'selected', projectId: id });
    };

    // Раздел поменяли извне (правка файла воркспейса): перечень и корни пересчитываются, окно не падает.
    ctx.subscriptions.add(
      config.onChange((value) => {
        const next = readProjects(value);
        const changes = diff(projects, next);
        if (changes.length === 0) return;
        projects = next;
        if (selectedId !== null && !projects.some((p) => p.id === selectedId)) void setSelected(null);
        void publishRoots().catch((error: unknown) => ctx.log(`корни не переданы ядру: ${messageOf(error)}`, 'warn'));
        for (const change of changes) emit(change);
        tell();
      }),
    );

    /** Поставщики секций формы свойств (`cyborg.project-settings`): описание берётся при каждом обращении, поставщик мог появиться позже. */
    async function sections(): Promise<Loaded[]> {
      const out: Loaded[] = [];
      for (const provider of ctx.contracts.all('cyborg.project-settings', 1)) {
        try {
          out.push({ provider, section: await provider.impl.section() });
        } catch (error) {
          ctx.log(`секция ${provider.pluginId} не отвечает: ${messageOf(error)}`, 'warn');
        }
      }
      return out.sort((a, b) => (a.section.order ?? 1000) - (b.section.order ?? 1000) || a.section.id.localeCompare(b.section.id));
    }

    /** projects:save: проверка проекта и секций, запись в слой воркспейса, корни ядру, сохранение секций, события. */
    async function save(raw: unknown): Promise<LoadReply> {
      const checked = validateProjectsState(raw);
      if (!checked.ok) throw new Error(checked.error);
      const settings = isRecord(raw) && isRecord(raw.settings) ? raw.settings : {};
      const known = new Set(projects.flatMap((p) => p.repos));
      const next: Project[] = [];
      for (const p of checked.state.projects) next.push({ ...p, repos: [...new Set(await Promise.all(p.repos.map((r) => (known.has(r) ? r : canonical(r)))))] });

      const loaded = await sections();
      const errors: string[] = [];
      for (const p of next) {
        const bySection = isRecord(settings[p.id]) ? settings[p.id] : {};
        for (const { provider, section } of loaded) {
          const values = (bySection as Record<string, unknown>)[section.id];
          if (values === undefined) continue;
          if (!isRecord(values)) {
            errors.push(`${section.title}: значения не объект`);
            continue;
          }
          try {
            for (const e of await provider.impl.validate(p.id, values)) errors.push(`${section.title}: ${e}`);
          } catch (error) {
            errors.push(`${section.title}: проверка не удалась (${messageOf(error)})`);
          }
        }
      }
      if (errors.length > 0) throw new Error(errors.join('; '));

      const prev = projects;
      projects = next;
      try {
        await config.set('workspace', { items: next.map(info) });
      } catch (error) {
        projects = prev;
        problem = problemFromRefusal(messageOf(error));
        throw new Error(projectsProblemText(problem, null));
      }
      problem = null;
      const last = checked.state.lastProjectId;
      await publishRoots();

      const saveErrors: string[] = [];
      for (const p of next) {
        const bySection = isRecord(settings[p.id]) ? settings[p.id] : {};
        for (const { provider, section } of loaded) {
          const values = (bySection as Record<string, unknown>)[section.id];
          if (!isRecord(values)) continue;
          try {
            await provider.impl.save(p.id, values);
          } catch (error) {
            saveErrors.push(`${section.title}: ${messageOf(error)}`);
          }
        }
      }
      for (const change of diff(prev, next)) emit(change);
      await setSelected(last !== null && next.some((p) => p.id === last) ? last : null);
      tell();
      if (saveErrors.length > 0) throw new Error(`Проект сохранён, но секции не записаны: ${saveErrors.join('; ')}`);
      return snapshot();
    }

    const provide: Projects = {
      list: async () => projects.map(info),
      selected: async () => {
        const found = projects.find((p) => p.id === selectedId);
        return found ? info(found) : null;
      },
      hasSelected: async () => selectedId !== null,
      roots: async (request) => {
        const owner =
          (request.projectId === undefined ? undefined : projects.find((p) => p.id === request.projectId)) ??
          projects.find((p) => p.repos.some((r) => isInside(request.repo, r))) ??
          projects.find((p) => p.id === selectedId);
        return treeRoots({ repo: request.repo, root: request.root, repos: owner?.repos ?? [request.repo] });
      },
      onChange: (listener): Subscription => {
        listeners.add(listener);
        return { dispose: () => void listeners.delete(listener) };
      },
    };
    ctx.subscriptions.add(ctx.contracts.provide('cyborg.projects', '1.0', provide));

    const reg = (name: string, handler: (...args: unknown[]) => unknown): void => void ctx.subscriptions.add(ctx.commands.register(name, handler));
    const str = (v: unknown, what: string): string => {
      if (typeof v !== 'string') throw new Error(`${what}: нужна строка`);
      return v;
    };

    // dialog:pickDir. Диалог показывает ядро; выбор человека становится областью granted, и каталог сразу уходит остальным плагинам как корень (до сохранения проекта).
    reg('projects.pick-dir', async () => {
      const chosen = await ctx.os.dialog.open({ title: 'Каталог репозитория', directory: true });
      const dir = chosen.find(isPlainPath);
      if (dir === undefined) return null;
      const real = await canonical(dir);
      picked.add(real);
      await publishRoots();
      return real;
    });
    reg('projects.load', () => snapshot());
    reg('projects.problem', () => currentProblem());
    reg('projects.save', (raw) => save(raw));
    reg('projects.select', async (id) => {
      const target = str(id, 'projects.select');
      if (target !== '' && !projects.some((p) => p.id === target)) throw new Error(`Проекта нет: ${target}`);
      await setSelected(target === '' ? null : target);
      tell();
      return selectedId;
    });
    reg('projects.remove', async (id) => {
      const target = str(id, 'projects.remove');
      if (!projects.some((p) => p.id === target)) throw new Error(`Проекта нет: ${target}`);
      return save({ projects: projects.filter((p) => p.id !== target).map(info), lastProjectId: selectedId === target ? null : selectedId });
    });
    reg('projects.form', async (id) => {
      const target = id === undefined ? undefined : str(id, 'projects.form');
      const found = target === undefined ? undefined : projects.find((p) => p.id === target);
      if (target !== undefined && !found) throw new Error(`Проекта нет: ${target}`);
      const loaded = await sections();
      const out: FormReply['sections'][number][] = [];
      for (const { provider, section } of loaded) {
        let values: SettingsValues = {};
        try {
          values = await provider.impl.load(found?.id ?? null);
        } catch (error) {
          ctx.log(`значения секции ${section.id}: ${messageOf(error)}`, 'warn');
        }
        out.push({ provider: provider.pluginId, section, values });
      }
      const reply: FormReply = { project: found ? info(found) : null, state: { projects: projects.map(info), lastProjectId: selectedId }, sections: out, problem: currentProblem() };
      return reply;
    });
    // Меню «Новый проект…» и «Свойства проекта…»: форма - модальное окно плагина; ответ - итог формы.
    const openForm = (projectId?: string): Promise<unknown> =>
      ctx.views.modal('project-form', { title: projectId === undefined ? 'Новый проект' : 'Свойства проекта', data: projectId === undefined ? {} : { projectId }, size: { width: 640, height: 520 }, escape: 'view' });
    reg('projects.new', () => openForm());
    reg('projects.edit', (id) => {
      const target = id === undefined ? selectedId : str(id, 'projects.edit');
      if (target === null || !projects.some((p) => p.id === target)) throw new Error('Проект не выбран');
      return openForm(target);
    });

    return publishRoots().then(
      () => undefined,
      (error: unknown) => {
        ctx.log(`корни не переданы ядру: ${messageOf(error)}`, 'warn');
        return undefined;
      },
    );
  },
};

export default plugin;
