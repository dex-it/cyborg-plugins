---
title: "Сайт документации"
description: "Как собирается и публикуется этот сайт, где лежат страницы и как добавить страницу."
---

Сайт - проект [Astro](https://astro.build/) с [Starlight](https://starlight.astro.build/) в каталоге `site/`, устроенный так же, как сайт ядра. Страницы лежат не в нём, а в `docs/guide/`: текст виден там же, где код, и правится обычным pull request. Адрес на GitHub Pages: `https://dex-it.github.io/cyborg-plugins/`.

## Что где лежит

| Путь | Что |
|---|---|
| `docs/guide/` | Страницы в Markdown: `start/`, `bundles/`, `authors/`, `development/`, `faq.md`, главная |
| `docs/guide/catalog/` | Страницы каталога; **генерируются** (`npm run docs:catalog`) |
| `site/astro.config.mjs` | Настройка Astro и Starlight, боковое меню (`sidebar`) |
| `site/site.config.mjs` | Адрес и бренд: `OWNER`, `REPO_NAME` и производные |
| `site/src/content.config.ts` | Берёт страницы из `docs/guide/`, а не из `site/src` |
| `site/scripts/` | `copy-brand.mjs` (значок) и `check-dist.mjs` (проверка сборки) |
| `assets/icon.svg` | Значок; сайт копирует его перед сборкой |
| `.github/workflows/docs-site.yml` | Сборка, проверка и публикация |

## Локально

```bash
npm run docs:catalog     # в корне: страницы каталога
cd site
npm ci
npm run dev              # сервер разработки
npm run build            # сборка в site/dist
npm run verify           # проверка собранного сайта
npm run check            # типы страниц и конфига
```

Версия Node для сайта - в `site/.nvmrc`.

## Как добавить страницу

1. Создайте `docs/guide/<раздел>/<страница>.md` с `title` и `description` в шапке. Заголовок первого уровня не пишите.
2. Добавьте страницу в `sidebar` в `site/astro.config.mjs`: порядок задаёт он, а не имена файлов. Страницы каталога меню строит само.
3. Корневые ссылки пишите как `/bundles/format/`, с конечным слэшем: базовый путь `/cyborg-plugins` добавит сборка.
4. `npm run build && npm run verify` в `site/`.

Страницы пишутся простым языком: короткие разделы, таблицы, врезки Starlight (`:::note[Заголовок]`, `:::tip`, `:::caution`). Дефис с пробелами вместо длинного тире, без эмодзи. Схемы - Mermaid блоком ` ```mermaid `; задавайте `accTitle` и `accDescr`.

## Страницы каталога

`docs/guide/catalog/` строит `scripts/gen-catalog.ts` из карточек `README.md`, манифестов, `plugins/categories.json` и `bundles/`. Руками их не правят: правка исчезнет при следующей генерации, а CI сверкой (`npm run check:docs-catalog`) не пропустит устаревшие страницы.

## Проверка сборки

`npm run verify` идёт по `site/dist` без сети: каждая внутренняя ссылка и ассет ведут под базовый путь на существующий файл, якоря находят свой `id`, у каждой страницы есть `canonical`, индекс поиска собран и покрывает все страницы, есть `sitemap-index.xml`. Внешние ссылки не проверяются: проверка должна быть детерминированной.

## Публикация

`docs-site.yml`: pull request собирает сайт и проверяет ссылки, ничего не публикуя; push в `master` собирает и публикует. Публикация идёт в окружение `github-pages`; в настройках репозитория в Pages выбран источник «GitHub Actions», а окружение принимает ветку `master`.
