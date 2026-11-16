// Сборка бандла: поставка ядра (`cyborg-plugin delivery`) + bundle.json + фрагмент plugins.enabled (+ архив).
//
//   <out>/<id>/
//     bundle.json     состав бандла с версиями плагинов
//     config.json     { "plugins": { "enabled": [...] } } - фрагмент для файла настроек
//     delivery/       результат `cyborg-plugin delivery`: <плагин>/ и delivery.json; это `builtinDir` приложения
//   <out>/<id>-<версия>.tgz   то же одним архивом (с --pack)

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { checkRepo } from './check-all.ts';
import { BUNDLE_FORMAT, resolveBundle } from './bundles.ts';
import { runCyborgPlugin } from './harness.ts';
import type { Problem } from './util.ts';

export interface BuildOptions {
  out: string;
  pack: boolean;
}

export interface BuildResult {
  dir: string;
  archive: string | undefined;
  plugins: string[];
}

export function buildBundle(root: string, id: string, options: BuildOptions): { result?: BuildResult; problems: Problem[] } {
  const { catalog, bundles, problems } = checkRepo(root);
  const bundle = bundles.bundles.find((b) => b.id === id);
  if (!bundle) return { problems: [...problems, { where: `bundles/${id}.json`, message: `бандла ${id} нет` }] };
  const resolved: Problem[] = [];
  const ids = resolveBundle(id, bundles.bundles, resolved);
  // Замечания репозитория целиком не мешают собрать здоровый бандл, но замечания этого бандла - мешают.
  const own = [...resolved, ...problems.filter((p) => p.where === bundle.rel || p.message.startsWith(`бандл ${id}:`))];
  if (own.length > 0) return { problems: own };

  const bundleDir = path.join(options.out, id);
  if (existsSync(bundleDir) && !existsSync(path.join(bundleDir, 'bundle.json'))) {
    return { problems: [{ where: bundleDir, message: 'каталог занят чужим содержимым (нет bundle.json): стирать не буду' }] };
  }
  rmSync(bundleDir, { recursive: true, force: true });
  mkdirSync(bundleDir, { recursive: true });

  const byId = new Map(catalog.plugins.map((p) => [p.id, p]));
  const dirs = ids.map((pluginId) => byId.get(pluginId)?.dir ?? '');
  const run = runCyborgPlugin(['delivery', ...dirs, '--out', path.join(bundleDir, 'delivery')], root);
  if (run.status !== 0) return { problems: [{ where: id, message: `cyborg-plugin delivery завершился с кодом ${run.status}` }] };

  const manifest = {
    format: BUNDLE_FORMAT,
    id: bundle.id,
    version: bundle.version,
    title: bundle.title,
    description: bundle.description,
    plugins: ids.map((pluginId) => ({ id: pluginId, version: byId.get(pluginId)?.manifest.version ?? '', category: byId.get(pluginId)?.category ?? '' })),
    enabled: ids,
  };
  writeFileSync(path.join(bundleDir, 'bundle.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(bundleDir, 'config.json'), `${JSON.stringify({ plugins: { enabled: ids } }, null, 2)}\n`);

  let archive: string | undefined;
  if (options.pack) {
    archive = path.join(options.out, `${id}-${bundle.version}.tgz`);
    const tar = spawnSync('tar', ['-czf', archive, '-C', options.out, id], { stdio: 'inherit' });
    if (tar.status !== 0) return { problems: [{ where: archive, message: `tar завершился с кодом ${tar.status ?? 'сигнал'}` }] };
  }
  return { result: { dir: bundleDir, archive, plugins: ids }, problems: [] };
}

export function listBundleIds(root: string): string[] {
  const dir = path.join(root, 'bundles');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.json') && n !== 'planned.json')
    .map((n) => n.slice(0, -'.json'.length))
    .sort();
}
