// Токены сессий для MCP-сервера (NFR-15001): токен называет сессию Cyborg, у каждой сессии свой, живёт только в памяти плагина.
// Хранит и отзывает их плагин `sessions` (решение 13 в docs/guide/development/decisions.md): на диск токен не попадает ни в каком виде,
// ядро передаёт его агенту переменной окружения процесса (`CYBORG_MCP_TOKEN`), а не аргументом и не файлом.

/** 32 случайных байта, base64url без заполнителя: 43 знака. */
function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class Tokens {
  private readonly bySession = new Map<string, string>();
  private readonly byToken = new Map<string, string>();

  /** Новый токен сессии; прежний токен той же сессии отозван. */
  issue(sessionId: string): string {
    this.revoke(sessionId);
    const token = randomToken();
    this.bySession.set(sessionId, token);
    this.byToken.set(token, sessionId);
    return token;
  }

  /** Токен выдан этой сессии и ещё не отозван. */
  has(sessionId: string): boolean {
    return this.bySession.has(sessionId);
  }

  /**
   * Токен, которым сессия уже пользуется вне Cyborg: у удалённой сессии его держит демон на хосте (`remote-sessions`, решение 13).
   * Принимается только для сессии, которой токен уже выдан (она запускается или идёт), по форме выданного (43 знака base64url) и если он не чужой.
   * Выданный `issue` токен заменяется. false - не принят.
   */
  adopt(sessionId: string, token: string): boolean {
    if (!this.bySession.has(sessionId) || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const holder = this.byToken.get(token);
    if (holder !== undefined && holder !== sessionId) return false;
    this.revoke(sessionId);
    this.bySession.set(sessionId, token);
    this.byToken.set(token, sessionId);
    return true;
  }

  /** Сессия по токену; неизвестный или отозванный токен - `undefined`. */
  sessionOf(token: string): string | undefined {
    return this.byToken.get(token);
  }

  /** Отзыв: сессия закрыта, вышла или не запустилась. Дальше её токен принимается как чужой. */
  revoke(sessionId: string): void {
    const token = this.bySession.get(sessionId);
    if (token === undefined) return;
    this.bySession.delete(sessionId);
    this.byToken.delete(token);
  }

  get size(): number {
    return this.byToken.size;
  }
}
