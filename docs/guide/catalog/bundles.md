---
title: "Бандлы"
description: "Именованные наборы плагинов, которые ставятся пачкой."
sidebar:
  order: 90
---

<!-- Страница сгенерирована: npm run docs:catalog. Правьте README.md плагина, манифест или plugins/categories.json, а не этот файл. -->

Бандл - список плагинов под одним именем: из него собирается поставка для приложения и фрагмент `plugins.enabled`. Как устроен формат и как собрать - в разделе [«Бандлы»](/bundles/).

:::note[Готовых бандлов пока нет]
Бандл появляется вместе с плагинами, которые в него входят: ссылка на несуществующий плагин не проходит проверку. Запланированные наборы - ниже.
:::

## Запланированы

### Сессии агента

Минимальное рабочее место: сессии Claude Code во вкладках с уведомлениями и изоляцией.

- Идентификатор: `agent-sessions`
- Плагины (5): `projects`, `agent-claude-code`, `sessions`, `session-isolation`, `session-notifications`

### Работа с кодом

Проекты, дерево файлов, просмотр, git и поиск рядом с сессией.

- Идентификатор: `code-workspace`
- Включает бандлы: `agent-sessions`
- Плагины (9): `projects`, `agent-claude-code`, `sessions`, `session-isolation`, `session-notifications`, `files`, `viewer`, `git`, `search`

### Задачи и MR

Задачи и MR из GitHub, GitLab и Jira, карточка «Статус».

- Идентификатор: `task-trackers`
- Включает бандлы: `code-workspace`
- Плагины (10): `projects`, `agent-claude-code`, `sessions`, `session-isolation`, `session-notifications`, `files`, `viewer`, `git`, `search`, `trackers`

### AI Cyborg

Всё, что умеет приложение ai-cyborg, но на ядре и плагинах: первая проверка на пригодность всей схемы.

- Идентификатор: `ai-cyborg`
- Включает бандлы: `task-trackers`
- Плагины (14): `projects`, `agent-claude-code`, `sessions`, `session-isolation`, `session-notifications`, `files`, `viewer`, `git`, `search`, `trackers`, `remote-sessions`, `next-actions`, `claude-extensions`, `command-buttons`
