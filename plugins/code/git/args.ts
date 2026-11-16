// Аргументы всех запусков программы плагина. Каждый набор закреплён правилом `permissions.process` манифеста (тест `rules.test.ts` сверяет их дословно),
// поэтому добавить запуск здесь значит добавить правило там.

/**
 * Начало аргументов любого запуска: конфиг репозитория из каталога человека недоверенный (SAFE_CONFIG ai-cyborg).
 * `core.fsmonitor=false` - команда из `.git/config` не запускается, `core.hooksPath=/dev/null` - хуки тоже, `--no-optional-locks` - чтение не пишет в индекс
 * и не будит наше же слежение за `.git`.
 */
export const SAFE_ARGS = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'] as const;

/** Выражение для `config --get-regexp`: драйверы фильтров, которые исполнил бы `git status`. */
export const FILTER_KEY = String.raw`^filter\..+\.(clean|process|required)$`;
/** Ключи, из-за которых смена ветки запустила бы команду из конфига репозитория: фильтры (smudge) и докачка partial clone транспортом из конфига. */
export const SWITCH_RISK_KEY = String.raw`^(filter\.|extensions\.partialclone$|remote\..*\.promisor$)`;

const CONFIG = ['config', '--show-scope', '--null', '--name-only', '--get-regexp'] as const;

export const STATUS_ARGS = ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'] as const;
export const FILTER_CONFIG_ARGS = [...CONFIG, FILTER_KEY] as const;
export const LS_STAGE_ARGS = ['ls-files', '--stage', '-z'] as const;
export const FILES_ARGS = ['ls-files', '-z', '--cached', '--others', '--exclude-standard'] as const;
export const ROOT_ARGS = ['rev-parse', '--show-toplevel'] as const;
export const BRANCH_ARGS = ['rev-parse', '--abbrev-ref', 'HEAD'] as const;
/** Размер объекта: `cat-file -s <HEAD:./путь>`. */
export const SIZE_ARGS = ['cat-file', '-s'] as const;
/** Содержимое объекта как есть: ни textconv, ни smudge-фильтр репозитория не запускаются. */
export const BLOB_ARGS = ['cat-file', 'blob'] as const;
export const REMOTES_ARGS = ['remote', '-v'] as const;
export const BRANCHES_ARGS = ['for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/heads', 'refs/remotes'] as const;
export const SWITCH_RISK_ARGS = [...CONFIG, SWITCH_RISK_KEY] as const;
/** Подмодули со своим непроверенным конфигом `switch` не трогает, даже если репозиторий задал `submodule.recurse`; `--` - дальше только имя ветки, не флаг. */
export const SWITCH_ARGS = ['-c', 'submodule.recurse=false', 'switch', '--'] as const;
