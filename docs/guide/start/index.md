---
title: "Быстрый старт"
description: "Как склонировать репозиторий, подключить ядро, проверить каталог и собрать бандл."
---

Репозиторий ничего не запускает сам: из него собираются плагины и бандлы, которые потом загружает приложение на ядре. Здесь - как получить результат на своей машине.

## Что нужно

- macOS или Linux (как и ядро; на Windows не проверялось);
- Node.js 24 и npm;
- клон [cyborg-harness](https://github.com/dex-it/cyborg-harness) рядом с этим репозиторием, пока пакеты ядра не опубликованы.

:::caution[Пакеты ядра ещё не в реестре]
`@cyborg-harness/*` и команда `cyborg-plugin` ждут выпуска ([P-10 ядра](https://github.com/dex-it/cyborg-harness/issues/11)). До него сборка идёт на клоне ядра: `npm run harness:link` кладёт в `node_modules` ссылки на него. После выпуска шаг уйдёт, а остальное не изменится.
:::

## Шаги

```bash
# 1. Ядро: собрать пакеты один раз
git clone https://github.com/dex-it/cyborg-harness.git
cd cyborg-harness && npm ci --ignore-scripts && npm run build:packages && cd ..

# 2. Этот репозиторий
git clone https://github.com/dex-it/cyborg-plugins.git
cd cyborg-plugins
npm install
npm run harness:link          # ссылки на ../cyborg-harness (или путь аргументом)

# 3. Проверить
npm run check                 # раскладка, карточки, бандлы
npm test                      # тесты скриптов и плагинов
```

Клон ядра можно держать где угодно: путь передаётся аргументом (`npm run harness:link -- /путь/к/cyborg-harness`) или переменной `CYBORG_HARNESS_DIR`.

## Собрать бандл

```bash
npm run bundle -- <id бандла>          # результат в dist/bundles/<id>/
npm run bundle -- --all --pack         # все бандлы, плюс архив <id>-<версия>.tgz
```

В `dist/bundles/<id>/` получится поставка для приложения (`delivery/`), состав бандла (`bundle.json`) и фрагмент настроек (`config.json`). Что с этим делать дальше - в разделе [«Подключить к приложению»](/start/use/); устройство бандлов - в разделе [«Бандлы»](/bundles/).

:::note[Бандлов пока нет]
Бандл существует, только пока существуют все его плагины, поэтому первые бандлы появятся вместе с первыми перенесёнными плагинами. Запланированные наборы описаны в [каталоге](/catalog/bundles/).
:::

## Все команды

| Команда | Что делает |
|---|---|
| `npm run check` | Раскладка `plugins/`, карточки README, манифесты по полям каталога, бандлы и их полнота |
| `npm run check:plugins` | `cyborg-plugin check` для каждого плагина: импорты, права, версия API |
| `npm run build` | `cyborg-plugin build` для каждого плагина в `dist/plugins/<id>` |
| `npm run typecheck` | Типы скриптов и каждого плагина |
| `npm test` | Тесты скриптов и тесты каждого плагина |
| `npm run bundle -- ...` | Сборка бандла |
| `npm run new -- <категория> <id>` | Новый плагин из шаблона |
| `npm run docs:catalog` | Пересобрать страницы каталога сайта |
| `npm run check:docs-catalog` | Сверить страницы каталога с источниками |
| `npm run harness:link` | Ссылки на собранный клон ядра |
