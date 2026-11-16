// Права `process` плагина: каждый запуск закреплён правилом манифеста (аргументы и переменные), опасные флаги и подкоманды вне правил отклоняет шлюз ядра до запуска.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { PluginContext } from '@cyborg-harness/contracts';
import type { InlinePlugin } from '@cyborg-harness/testing';
import * as args from '../args.ts';
import { CHANNELS } from '../index.ts';
import { repo, rig, PLUGIN_DIR } from './kit.ts';

interface Rule {
  readonly program: string;
  readonly args: readonly string[];
  readonly env?: readonly string[];
  readonly deny?: readonly string[];
}

const manifest = JSON.parse(readFileSync(path.join(PLUGIN_DIR, 'manifest.json'), 'utf8')) as { permissions: { process: Rule[]; 'fs.read': string[] }; provides: Record<string, { guard: Record<string, unknown> }> };
const rules = manifest.permissions.process;

/** Всё, чем плагин запускает git: имя -> аргументы после закреплённого начала. */
const LAUNCHES = {
  status: args.STATUS_ARGS,
  filterConfig: args.FILTER_CONFIG_ARGS,
  lsStage: args.LS_STAGE_ARGS,
  files: args.FILES_ARGS,
  root: args.ROOT_ARGS,
  branch: args.BRANCH_ARGS,
  size: args.SIZE_ARGS,
  blob: args.BLOB_ARGS,
  remotes: args.REMOTES_ARGS,
  branches: args.BRANCHES_ARGS,
  switchRisk: args.SWITCH_RISK_ARGS,
  switch: args.SWITCH_ARGS,
} as const;

const ROGUE: InlinePlugin = {
  manifest: { id: 'rogue', version: '1.0.0', engines: { cyborg: '^1' }, commands: { 'rogue.run': { args: ['string', 'array'] } }, permissions: { 'fs.read': ['workspace'], process: rules } },
  module: {
    activate(ctx: PluginContext) {
      ctx.commands.register('rogue.run', async (cwd, argv) => {
        try {
          const r = await ctx.os.process?.run('git', argv as string[], { cwd: String(cwd) });
          return { ok: true, code: r?.code };
        } catch (e) {
          return { ok: false, code: (e as { code?: string }).code };
        }
      });
      return undefined;
    },
  },
};

describe('git: правила process закрепляют запуски', () => {
  it('на каждый запуск плагина есть ровно одно правило с теми же аргументами, лишних правил нет', () => {
    const wanted = Object.values(LAUNCHES).map((tail) => [...args.SAFE_ARGS, ...tail]);
    assert.deepEqual(rules.map((r) => r.args), wanted);
    for (const rule of rules) assert.equal(rule.program, 'git');
  });

  it('каждое правило начинается с отключения fsmonitor, хуков и необязательных замков', () => {
    for (const rule of rules) assert.deepEqual(rule.args.slice(0, args.SAFE_ARGS.length), [...args.SAFE_ARGS], rule.args.join(' '));
    assert.deepEqual(args.SAFE_ARGS, ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']);
  });

  it('у каждого правила запрещены флаги, меняющие конфиг, каталог и исполняемые программы; у смены ветки - ещё и флаги, меняющие смысл команды', () => {
    const core = ['-c', '-C', '--config-env', '--output', '--git-dir', '--work-tree', '--exec-path', '--ext-diff', '--textconv'];
    for (const rule of rules) for (const flag of core) assert.ok(rule.deny?.includes(flag), `${rule.args.slice(5).join(' ')}: нет запрета ${flag}`);
    const switchRule = rules.find((r) => r.args.includes('switch'));
    for (const flag of ['--force', '-f', '--discard-changes', '--orphan', '--detach', '--merge', '--recurse-submodules', '--force-create']) assert.ok(switchRule?.deny?.includes(flag), flag);
  });

  it('переменные окружения получают только правила, которым они нужны: перекрытие фильтров у status, LC_ALL у запросов ключей конфига', () => {
    const envOf = (tail: readonly string[]) => rules.find((r) => r.args.join('\0') === [...args.SAFE_ARGS, ...tail].join('\0'))?.env;
    assert.deepEqual(envOf(args.STATUS_ARGS), ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_*', 'GIT_CONFIG_VALUE_*']);
    assert.deepEqual(envOf(args.FILTER_CONFIG_ARGS), ['LC_ALL']);
    assert.deepEqual(envOf(args.SWITCH_RISK_ARGS), ['LC_ALL']);
    for (const name of ['lsStage', 'files', 'root', 'branch', 'size', 'blob', 'remotes', 'branches', 'switch'] as const) assert.equal(envOf(LAUNCHES[name]), undefined, name);
  });

  it('выражения ключей конфига закреплены дословно', () => {
    assert.equal(args.FILTER_KEY, '^filter\\..+\\.(clean|process|required)$');
    assert.equal(args.SWITCH_RISK_KEY, '^(filter\\.|extensions\\.partialclone$|remote\\..*\\.promisor$)');
  });

  it('чтение репозитория читает только workspace; записи вне своих каталогов у плагина нет', () => {
    assert.deepEqual(manifest.permissions['fs.read'], ['workspace']);
    assert.deepEqual(Object.keys(manifest.permissions).toSorted(), ['fs.read', 'process']);
  });

  it('каналы владельца ai-cyborg заменены членами контракта: каждый член объявлен с guard fs.read на первый аргумент', () => {
    assert.deepEqual(CHANNELS, { 'git:root': 'root', 'git:branch': 'branch', 'git:status': 'status', 'git:branches': 'branches', 'git:switch': 'switch', 'git:headContent': 'headContent' });
    const guard = manifest.provides['cyborg.git']?.guard ?? {};
    for (const member of [...Object.values(CHANNELS), 'remotes', 'files', 'onChange']) assert.deepEqual(guard[member], { 'fs.read': 0 }, member);
  });
});

describe('git: шлюз отклоняет всё, что вне правил (K-34)', () => {
  it('флаги из deny в хвосте, в том числе в форме флаг=значение, и подкоманды вне правил не запускаются', async () => {
    using r = repo({ branches: ['feature'] });
    await using t = await rig({ repos: [r.dir], extra: [ROGUE] });
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'rogue' });
    const run = (argv: string[]) => t.kernel.run('rogue.run', r.dir, argv) as Promise<{ ok: boolean; code?: string | number }>;
    const safe = [...args.SAFE_ARGS];
    const marker = path.join(t.box.root, 'out.txt');
    const denied = { ok: false, code: 'PermissionDenied' };

    for (const tail of [['-c', 'core.sshCommand=touch x'], ['--output', marker], [`--output=${marker}`], ['--exec-path=/tmp/evil'], ['--git-dir=/tmp/x'], ['--textconv']]) {
      assert.deepEqual(await run([...safe, ...args.FILES_ARGS, ...tail]), denied, tail.join(' '));
    }
    for (const tail of [['--force', 'feature'], ['-f', 'feature'], ['--orphan=x'], ['--discard-changes', 'feature'], ['--detach', 'feature'], ['--recurse-submodules', 'feature']]) {
      assert.deepEqual(await run([...safe, ...args.SWITCH_ARGS, ...tail]), denied, tail.join(' '));
    }
    assert.equal(existsSync(marker), false, 'git не запускался');

    // Подкоманды, которых плагин не просит, и закреплённое начало без нужных флагов безопасности.
    for (const argv of [
      [...safe, 'log', '--oneline'],
      [...safe, 'push'],
      [...safe, 'fetch'],
      [...safe, 'checkout', 'feature'],
      [...safe, 'reset', '--hard'],
      [...safe, 'config', 'core.sshCommand', 'touch x'],
      [...safe, 'config', '--get-regexp', '.*'],
      [...safe, 'grep', '-O', 'x'],
      [...safe, 'switch', 'feature'],
      [...safe, 'cat-file', '--textconv', 'HEAD:./README.md'],
      ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'],
      ['-c', 'core.fsmonitor=true', ...args.STATUS_ARGS],
      ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args.STATUS_ARGS],
    ]) {
      assert.deepEqual(await run(argv), denied, argv.join(' '));
    }
    // Разрешённое проходит.
    assert.deepEqual(await run([...safe, ...args.ROOT_ARGS]), { ok: true, code: 0 });
    assert.deepEqual(await run([...safe, ...args.SWITCH_ARGS, 'feature']), { ok: true, code: 0 });
    const flags = t.kernel.journal.flatMap((e) => (e.kind === 'denied' && e.pluginId === 'rogue' && e.detail?.startsWith('запрещён флаг') ? [e.detail] : []));
    assert.ok(flags.some((d) => d.includes('--output')) && flags.some((d) => d.includes('--force')) && flags.some((d) => d.includes('-c ')), flags.join('; '));
  });
});
