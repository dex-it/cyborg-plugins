// Тесты демона на node:test, как в ai-cyborg (scripts/test.mjs): esbuild собирает каждый test/*.test.ts во временный каталог.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const only = process.argv.slice(2);
const entries = readdirSync(path.join(root, 'test'))
  .filter((name) => name.endsWith('.test.ts') && (!only.length || only.some((o) => name.includes(o))))
  .map((name) => path.join(root, 'test', name));
const out = mkdtempSync(path.join(tmpdir(), 'cyborg-agentd-test-'));
try {
  await build({ entryPoints: entries, outdir: out, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'warning' });
  const files = entries.map((e) => path.join(out, path.basename(e).replace(/\.ts$/, '.js')));
  const run = spawnSync(process.execPath, ['--test', '--test-timeout=120000', ...files], { stdio: 'inherit', env: { ...process.env, COMPANION_ROOT: root } });
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
