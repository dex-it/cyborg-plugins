// Сборка демона и его клиента для SSH-хоста в по одному файлу JS: исходники ai-cyborg (src/agentd и то, что они тянут из src/main и src/shared) лежат здесь без правок,
// client.ts - новое (rpc и attach для ядра без стримингового процесса). Результат кладётся в ресурсы плагина remote-sessions
// (расширение .txt: cyborg-plugin check читает любой .js как код плагина и бракует node:*). Затем: `npm run embed-assets -- plugins/sessions/remote-sessions`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const here = path.dirname(new URL(import.meta.url).pathname);
export const ROOT = path.resolve(here, '..');
export const OUT_DIR = path.resolve(ROOT, '../../plugins/sessions/remote-sessions/assets/agentd');
/** Что собирается: точка входа -> файл ресурса. */
export const ENTRIES = { 'src/agentd/agentd.ts': 'agentd.js.txt', 'src/agentd/client.ts': 'client.js.txt' };

/** Текст собранной программы; платформа и цель те же, что в ai-cyborg (scripts/build.mjs): Node 18 на хосте, без карты исходников и сжатия. */
export async function bundle(entry) {
  const result = await build({
    entryPoints: [path.join(ROOT, entry)],
    // Пути в комментариях сборки считаются от корня репозитория: результат не зависит от того, откуда запущена команда.
    absWorkingDir: path.resolve(ROOT, '../..'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    sourcemap: false,
    minify: false,
    write: false,
    logLevel: 'warning',
  });
  return result.outputFiles[0].text;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes('--check');
  let stale = false;
  for (const [entry, name] of Object.entries(ENTRIES)) {
    const text = await bundle(entry);
    const file = path.join(OUT_DIR, name);
    if (check) {
      let current = '';
      try {
        current = readFileSync(file, 'utf8');
      } catch {
        // файла нет: устарел
      }
      if (current !== text) {
        console.error(`build:companions: ${path.relative(process.cwd(), file)} устарел, выполните npm run build:companions и npm run embed-assets -- plugins/sessions/remote-sessions`);
        stale = true;
      }
    } else {
      mkdirSync(OUT_DIR, { recursive: true });
      writeFileSync(file, text);
      console.log(`build:companions: ${path.relative(process.cwd(), file)} (${text.length} байт)`);
    }
  }
  if (check) {
    if (stale) process.exit(1);
    console.log('build:companions: демон и клиент свежи');
  }
}
