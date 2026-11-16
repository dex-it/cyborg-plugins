---
title: "Карта контрактов"
description: "Какой плагин какие контракты cyborg.* даёт и берёт: по манифестам готовых плагинов и проектной модели запланированных."
sidebar:
  order: 91
---

<!-- Страница сгенерирована: npm run docs:catalog. Правьте README.md плагина, манифест или plugins/categories.json, а не этот файл. -->

Плагины общаются только контрактами. Для готового плагина строка строится по его `manifest.json`, для запланированного - по проектной модели `plugins/planned-contracts.json`; поэтому карта полна с первого дня и сама заменяется настоящими данными по мере переноса. Пробелы относительно типов ядра показывает `npm run contracts:gap`.

| Контракт | Даёт | Требует | Использует, если есть | Собирает у всех | Нужные члены |
|---|---|---|---|---|---|
| `cyborg.agent` | `agent-claude-code`, `agent-shell`, `remote-sessions` | - | - | `sessions` | `facts`, `launch`, `watch`, `ended`, `history` |
| `cyborg.agent-tool` | `next-actions` | - | - | `sessions` | `tools`, `call` |
| `cyborg.editor` | `viewer` | - | `command-buttons` | - | `open`, `openWithValidation` |
| `cyborg.git` | `git` | `trackers` | `command-buttons`, `files`, `search`, `viewer` | - | `status`, `onChange`, `root`, `branch`, `headContent`, `branches`, `switch`, `remotes`, `files` |
| `cyborg.project-settings` | `remote-sessions`, `trackers`, `trackers-http` | - | - | `projects` | `section`, `validate`, `onChange` |
| `cyborg.projects` | `projects` | `files`, `search`, `sessions`, `trackers`, `trackers-http` | `agent-claude-code`, `claude-extensions`, `remote-sessions` | - | `list`, `selected`, `onChange`, `roots` |
| `cyborg.session-prompt` | `next-actions`, `session-isolation` | - | - | `sessions` | `fragment`, `order` |
| `cyborg.sessions` | `sessions` | `command-buttons`, `session-notifications`, `trackers`, `trackers-http` | `files`, `git` | - | `onChange`, `reveal`, `create`, `send`, `paste`, `labels`, `uses` |
| `cyborg.tree-decoration` | `git` | - | - | `files` | `marks`, `onChange` |

Готовых плагинов в карте 0, по проектной модели 17.
