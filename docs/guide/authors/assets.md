---
title: "Ресурсы плагина: плагин Claude Code, демон, файлы вида"
description: "Что из каталога плагина доезжает до поставки, почему assets/ нельзя хранить как .mjs, и как вшить навык, хук и демон в index.mjs и установить при активации."
---

Поставка плагина - это то, что собирает `cyborg-plugin build`. Если плагину нужны файлы сверх кода (навык и хук для Claude Code, программа, которую он отправляет на SSH-хост, шрифты и Monaco для вида), нужно знать, что именно доедет до пользователя. Ниже результат спайка SP-02 ([#8](https://github.com/dex-it/cyborg-plugins/issues/8)), проверенный на настоящих `cyborg-plugin` и ядре (`scripts/test/assets-e2e.test.ts`).

## Что доезжает до поставки

| Что лежит в плагине | В поставке |
|---|---|
| `manifest.json`, файлы схем `config.schema` и `state.schema` | да |
| Главная часть и всё, что она импортирует (`.ts`, `.json`) | вшито в `index.mjs` |
| Виды `ui/*.ts` | собраны в `ui/*.js` |
| Не-исходное содержимое `ui/` (стили, шрифты, `ui/vendor/*.js`) | копируется как есть |
| Любые другие каталоги (`assets/`, `skills/`, `hooks/`) | **нет** |
| Импорт `.md` и других текстовых файлов в главной части | отказ сборки: загрузчика для них нет |

Импорт `.json` и TS-модуля со строкой работает: так ресурсы и попадают в поставку, строками внутри `index.mjs`. Своего пути на диске плагин не знает: `ctx.os.paths` отдаёт только `data`, `temp` и `home`.

## Исходные расширения в каталоге плагина запрещены

`cyborg-plugin check` и `build` читают **все** файлы `.ts`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs` в каталоге плагина, а не только достижимые из точки входа, и бракуют `node:*` в любом из них. Демон для SSH-хоста - программа на Node с `node:fs` и `node:net`; положить его в плагин как `agentd.mjs` нельзя.

| Расширение ресурса | `check` |
|---|---|
| `.txt`, `.md`, `.json`, `.sh`, `.tpl` | не читает |
| `.ts`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`, `.jsx`, `.tsx` | читает как код плагина |

Поэтому исходный файл ресурса называют с добавкой `.txt`: `agentd.js.txt`. При установке `.txt` снимается.

## Решение: вшить строками и записать при активации

1. Положите ресурсы в `assets/` плагина. Исходное расширение дополните `.txt`.
2. `npm run embed-assets -- plugins/<категория>/<id>` создаёт `assets.generated.ts`: ресурсы строками (`ASSETS`), хеш содержимого (`ASSET_VERSION`) и функцию `installAssets(ctx.os)`.
3. Закоммитьте `assets.generated.ts`. `npm run check` сверяет его с `assets/`, устаревший модуль - замечание; `npm run embed-assets -- --all --check` делает то же отдельно.
4. В `activate` вызовите установку:

   ```ts
   import { installAssets } from './assets.generated.ts';

   const plugin: PluginModule = {
     async activate(ctx) {
       const dir = await installAssets(ctx.os); // <данные плагина>/assets/<версия>/
       // ...
     },
   };
   ```

`installAssets` кладёт файлы в `<данные плагина>/assets/<версия>/`, право `fs.write` не нужно: свой каталог данных открыт без права. Установленная версия не переписывается (маркер `.installed`), изменённый ресурс получает новую версию в соседнем каталоге, старая остаётся на месте. Запись атомарна, бит исполнения не выставляется.

Пределы: только текст UTF-8, до 1 МиБ на файл и 2 МиБ на плагин (всё лежит в `index.mjs`). Двоичное кодируют в base64 текстом.

## Три типичных случая

### Плагин Claude Code со скиллами и хуками

В ai-cyborg каталог `plugin/` подключается к сессии ключом `--plugin-dir`. На ядре: ресурсы `assets/.claude-plugin/plugin.json`, `assets/skills/...`, `assets/hooks/...`; после `installAssets` каталог передаётся в `claude` переменной окружения.

- Правило `pty` в манифесте называет переменную в `env` (например, `CYBORG_PLUGIN`), а запуск читает `--plugin-dir "$CYBORG_PLUGIN"`.
- Хуки вызываются как `bash "${CLAUDE_PLUGIN_ROOT}/hooks/lsp-reap.sh"`, как в ai-cyborg: файл без бита исполнения работает (проверено тестом: права `0644`, `bash` запускает).

### Демон для SSH-хоста

Демон ai-cyborg уже ставится текстом: `ssh host sh -s` получает скрипт установки с содержимым демона и проверкой `sha256` (`src/main/remote/install.ts`). На ядре то же: текст демона берётся из `ASSETS['agentd/agentd.js']`, отправляется через `ctx.os.process.run('ssh', [...], { input })` по правилу `process` на `ssh`. Хеш для проверки на хосте - `ASSET_VERSION` или `sha256` текста.

Исходники демона на TypeScript с `node:*` в каталоге плагина лежать не могут. Их собирают отдельно (esbuild в один файл) из каталога вне плагина, например `companions/agentd/`, а результат кладут в `assets/agentd/agentd.js.txt`. Скрипт сборки - `npm run build:companions` (`companions/agentd/scripts/build.mjs`, esbuild, точки входа и файлы ресурсов перечислены в `ENTRIES`): он кладёт результат в `assets/agentd/agentd.js.txt` и `client.js.txt` плагина `remote-sessions`, затем `npm run embed-assets -- plugins/sessions/remote-sessions` вшивает их в `assets.generated.ts`. Тест плагина сверяет ресурсы со свежей сборкой, так что устаревший демон не доедет до поставки молча. Тесты программ лежат рядом (`companions/agentd/test`, `node companions/agentd/scripts/test.mjs`) и идут в `npm test` плагина.

### Monaco, шрифты и стили вида

Лежат в `ui/` и копируются как есть (проверено: `ui/vendor/monaco.js`, `ui/font.woff2`, `ui/style.css` в результате сборки). Фрейм вида грузит ресурсы только со своего origin; для Monaco нужен `ui.inlineStyles: true` в манифесте.

## Что не проверено

`claude --plugin-dir` на настоящем `claude` в тестах не запускается: подставной `claude` и ручная проверка на живом - в задаче M-04. Установка и запуск ресурсов, работа `node` и `bash` по правилу `process` проверены на настоящем ядре.

## Команды

```bash
npm run embed-assets -- plugins/sessions/sessions   # собрать assets.generated.ts одного плагина
npm run embed-assets -- --all                       # у всех плагинов с assets/
npm run embed-assets -- --all --check               # только сверить
```
