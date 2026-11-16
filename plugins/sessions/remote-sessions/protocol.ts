// Типы сообщений демона, которые нужны плагину: формы скопированы из companions/agentd/src/agentd/protocol.ts (тот файл - источник).

/** Доступ к git-хостингу из gh или glab оператора. */
export interface GitCred {
  kind: 'github' | 'gitlab';
  host: string;
  token: string;
}

/** Доступы агента: только в памяти демона и в окружении процессов сессии, в meta.json не пишутся. */
export interface Auth {
  git: GitCred[];
  /** Хост origin рабочего репозитория: его токен glab получает первым. */
  primary?: string;
  /** Токен claude setup-token: вход агента без claude auth login на хосте. */
  claude?: string;
}

export interface RepoSpec {
  /** Путь локального репозитория: по нему Cyborg узнаёт проект сессии. */
  local: string;
  url: string;
  name: string;
}

/** Пределы сессии для демона (`SpawnMsg.limits`). */
export interface Limits {
  maxPerHost: number;
  taskMs: number;
  idleMs: number;
}

export interface CleanupResult {
  removed: string[];
  kept: { path: string; reason: string }[];
}
