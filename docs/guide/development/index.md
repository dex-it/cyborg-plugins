---
title: "Разработка"
description: "Как устроена разработка репозитория: карта переноса, CI, связь с ядром, сайт."
---

| Страница | О чём |
|---|---|
| [Карта переноса](/development/roadmap/) | Что из ai-cyborg в какой плагин, бандл и в каком порядке переезжает |
| [Решения по переносу](/development/decisions/) | Что решено по D-00: где приложение, границы плагинов, промпт, кнопки, заморозка, бюджеты |
| [Контракты для переноса](/development/contracts/) | Что есть в ядре, чего не хватает 14 плагинам, задачи в ядре, команда `contracts:gap` |
| [Задачи, метки и ключи](/development/labels/) | Уровни задач, ключи в названиях, группы меток, этапы, файл `labels.json` |
| [CI и релизы](/development/ci/) | Что проверяет каждый pull request, как выходят бандлы |
| [Что нужно от ядра](/development/harness/) | Зависимости от Cyborg Harness и предложения ядру |
| [Сайт документации](/development/docs-site/) | Как собирается и публикуется этот сайт |

## Окружение

Нужны Node.js 24, npm, git и собранный клон [cyborg-harness](https://github.com/dex-it/cyborg-harness) рядом ([быстрый старт](/start/)).

```bash
npm install
npm run harness:link
npm run check && npm run check:plugins && npm run typecheck && npm test
```

## Правила кода

- Скрипты на TypeScript, запускаются Node 24 без сборки; импорты пишутся с расширением `.ts`.
- Параметры-свойства конструктора и `enum` не пишут: Node снимает только стираемый синтаксис.
- Скрипты не зависят от npm-пакетов, кроме `typescript` и `@types/node` для проверки типов.
- Плагин импортирует только `@cyborg-harness/contracts` и свои модули (правило ядра, его держит `cyborg-plugin check`).
- `node_modules/`, `dist/` и `package-lock.json` руками не правят; страницы `docs/guide/catalog/` - тоже.

## Цикл изменения

1. Ветка от `master` с коротким именем по сути.
2. Изменение вместе с тестом и правкой документации: страницы лежат в `docs/guide/`.
3. `npm run check && npm run check:plugins && npm run typecheck && npm test`; если менялись плагины или бандлы - `npm run docs:catalog`; если менялись метки - `npm run sync-labels`.
4. Pull request в `master`; слияние после зелёного CI.
