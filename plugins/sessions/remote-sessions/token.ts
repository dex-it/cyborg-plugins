// Токен `claude setup-token` для входа удалённых агентов. В ai-cyborg он лежал в файле, зашифрованном safeStorage Electron (claude-token.ts);
// на ядре он живёт в хранилище секретов ядра (`ctx.os.secrets`): ни в файле плагина, ни в config, ни в аргументах `ssh`, а ядро вычёркивает его из журнала.
import type { OsSecrets } from '@cyborg-harness/contracts';

export interface ClaudeTokenStatus {
  set: boolean;
  /** secrets - в хранилище секретов ядра; в файлах плагина токена нет. */
  stored: 'secrets' | null;
}

const TOKEN = /^[\x21-\x7e]{20,4096}$/;
export const TOKEN_KEY = 'claude-token';

export class ClaudeTokenStore {
  private readonly secrets: OsSecrets;
  private cache: string | null | undefined;

  constructor(secrets: OsSecrets) {
    this.secrets = secrets;
  }

  /** Токен или null; хранилища нет (система без шифрования) - тоже null. */
  async get(): Promise<string | null> {
    if (this.cache !== undefined) return this.cache;
    try {
      const value = await this.secrets.get(TOKEN_KEY);
      this.cache = value !== undefined && TOKEN.test(value) ? value : null;
    } catch {
      return null;
    }
    return this.cache;
  }

  async status(): Promise<ClaudeTokenStatus> {
    const token = await this.get();
    return { set: token !== null, stored: token === null ? null : 'secrets' };
  }

  async set(value: unknown): Promise<ClaudeTokenStatus> {
    const token = typeof value === 'string' ? value.trim() : '';
    if (!TOKEN.test(token)) throw new Error('Токен - строка из claude setup-token без пробелов');
    await this.secrets.set(TOKEN_KEY, token);
    this.cache = token;
    return { set: true, stored: 'secrets' };
  }

  async clear(): Promise<ClaudeTokenStatus> {
    await this.secrets.delete(TOKEN_KEY);
    this.cache = null;
    return { set: false, stored: null };
  }
}
