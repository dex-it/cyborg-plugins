// Общее для тестов плагина projects: ядро на тест-ките с проектами, подставным поставщиком секции `cyborg.project-settings`,
// «читателем» с правом читать область workspace (так видно, что корень дошёл до остальных плагинов) и подставным диалогом выбора каталога.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { InlinePlugin, TestKernel } from '@cyborg-harness/testing';
import { memoryStore, sandbox, startKernel, type MemoryStore, type Sandbox } from '@cyborg-harness/testing';
import type { PluginContext } from '@cyborg-harness/contracts';

export const home = path.resolve(import.meta.dirname, '..');

const manifest = (id: string, extra: Record<string, unknown>): Record<string, unknown> => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...extra });

/** Плагин с правом читать область workspace: `reader.read <путь>` отдаёт текст файла или бросает отказ ядра. */
export const reader: InlinePlugin = {
  manifest: manifest('reader', { commands: { 'reader.read': { args: ['string'] } }, permissions: { 'fs.read': ['workspace'] } }),
  module: {
    activate(ctx: PluginContext) {
      ctx.commands.register('reader.read', (file) => ctx.os.fs.readText(String(file)));
      return undefined;
    },
  },
};

export interface Saved {
  readonly projectId: string;
  readonly values: Record<string, unknown>;
}

/** Подставной поставщик секции «Источники» (его место займёт `trackers`): булевы поля, проверка и запись видны тесту. */
export function sourcesProvider(options: { fail?: string } = {}) {
  const saved: Saved[] = [];
  const validated: Saved[] = [];
  const plugin: InlinePlugin = {
    manifest: manifest('trackers', { provides: { 'cyborg.project-settings': '1.0' } }),
    module: {
      activate(ctx: PluginContext) {
        ctx.contracts.provide('cyborg.project-settings', '1.0', {
          section: async () => ({ id: 'sources', title: 'Источники задач', order: 10, fields: [{ id: 'github', kind: 'boolean', label: 'GitHub' }, { id: 'gitlab', kind: 'boolean', label: 'GitLab' }] }),
          load: async (projectId: string | null) => ({ github: projectId === 'with-github', gitlab: false }),
          validate: async (projectId: string | null, values: Readonly<Record<string, unknown>>) => {
            validated.push({ projectId: projectId ?? '', values: { ...values } });
            return typeof values.github === 'boolean' && typeof values.gitlab === 'boolean' ? [] : ['оба флага должны быть булевыми'];
          },
          save: async (projectId: string, values: Readonly<Record<string, unknown>>) => {
            if (options.fail) throw new Error(options.fail);
            saved.push({ projectId, values: { ...values } });
          },
          onChange: () => ({ dispose() {} }),
        });
        return undefined;
      },
    },
  };
  return { plugin, saved, validated };
}

/** Каталог репозитория в песочнице с файлом `key.txt`, который читает `reader`. */
export async function makeDir(box: Sandbox, name: string): Promise<string> {
  const full = box.path(name);
  await mkdir(full, { recursive: true });
  await writeFile(path.join(full, 'key.txt'), `ключ ${name}`);
  return full;
}

export interface Rig {
  readonly kernel: TestKernel;
  readonly box: Sandbox;
  readonly store: MemoryStore;
  readonly state: MemoryStore;
  /** Что вернёт следующий диалог выбора каталога; пусто - отмена. */
  readonly dialog: string[][];
  /** Список, который `reader` читает как workspace: имя каталога -> путь. */
  dir(name: string): Promise<string>;
}

export interface RigOptions {
  readonly config?: Record<string, Record<string, unknown>>;
  readonly state?: Record<string, Record<string, unknown>>;
  readonly extra?: readonly InlinePlugin[];
  readonly box?: Sandbox;
}

/** Ядро с `projects` из поставки (`bundled`), читателем и дополнительными плагинами. */
export async function rig(options: RigOptions = {}): Promise<Rig & AsyncDisposable> {
  const box = options.box ?? (await sandbox('projects-'));
  const store = memoryStore(options.config ? { workspace: options.config } : {});
  const state = memoryStore(options.state ? { workspace: options.state } : {});
  const dialog: string[][] = [];
  const kernel = await startKernel({
    plugins: [home, reader, ...(options.extra ?? [])],
    config: store.store,
    state: state.store,
    os: { dialog: { open: async () => dialog.shift() ?? [] } },
    load: { reservedPrefixes: ['cyborg.'], bundled: ['projects', 'trackers'] },
  });
  const dir = (name: string): Promise<string> => makeDir(box, name);
  return {
    kernel,
    box,
    store,
    state,
    dialog,
    dir,
    [Symbol.asyncDispose]: async () => {
      await kernel[Symbol.asyncDispose]();
      if (!options.box) await box[Symbol.asyncDispose]();
    },
  };
}
