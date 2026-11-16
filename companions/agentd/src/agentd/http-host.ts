// НОВОЕ относительно ai-cyborg: перезапись заголовка Host в запросах HTTP/1.1, идущих через туннель MCP.
//
// Сервер MCP на ядре (`ctx.os.serve`) принимает запрос, только если Host - `127.0.0.1:<его порт>` (защита от подмены DNS). Агент на хосте обращается к прокси демона
// на его порту, и Host у запроса - порт прокси, а не сервера: ядро ответило бы 421. Клиент `attach` стоит между демоном и туннелем и подставляет Host сервера.
// Разбор - минимальный конечный автомат по запросам с `Content-Length` (так шлёт тело JSON-RPC клиент MCP); запрос с `Transfer-Encoding: chunked` или Upgrade
// проходит с исправленным Host, а дальше соединение идёт как есть (следующие запросы на нём Host не получат).

const HEAD_END = Buffer.from('\r\n\r\n');
/** Предел заголовков одного запроса: больше - соединение идёт как есть (не HTTP либо мусор). */
const MAX_HEAD = 64 * 1024;

export class HostRewriter {
  private readonly host: string;
  private head: Buffer = Buffer.alloc(0);
  private body = 0;
  private raw = false;

  /** `host` - значение заголовка Host, которое ждёт сервер (`127.0.0.1:12345`). */
  constructor(host: string) {
    this.host = host;
  }

  /** Байты запроса от агента: отдаёт то, что надо передать серверу. */
  push(chunk: Buffer): Buffer {
    if (this.raw) return chunk;
    const out: Buffer[] = [];
    let rest = chunk;
    while (rest.length > 0) {
      if (this.body > 0) {
        const take = Math.min(this.body, rest.length);
        out.push(rest.subarray(0, take));
        this.body -= take;
        rest = rest.subarray(take);
        continue;
      }
      this.head = Buffer.concat([this.head, rest]);
      rest = Buffer.alloc(0);
      const end = this.head.indexOf(HEAD_END);
      if (end < 0) {
        if (this.head.length > MAX_HEAD) {
          out.push(this.head);
          this.head = Buffer.alloc(0);
          this.raw = true;
        }
        break;
      }
      const text = this.head.subarray(0, end).toString('latin1');
      const after = this.head.subarray(end + HEAD_END.length);
      this.head = Buffer.alloc(0);
      const lines = text.split('\r\n');
      let length = 0;
      let chunked = false;
      const fixed = lines.map((line, i) => {
        if (i === 0) return line;
        const name = /^([^:]+):/.exec(line)?.[1]?.trim().toLowerCase();
        if (name === 'host') return `Host: ${this.host}`;
        if (name === 'content-length') length = Number(line.slice(line.indexOf(':') + 1).trim()) || 0;
        if (name === 'transfer-encoding' && /chunked/i.test(line)) chunked = true;
        if (name === 'upgrade') chunked = true;
        return line;
      });
      if (!fixed.some((l, i) => i > 0 && /^host:/i.test(l))) fixed.push(`Host: ${this.host}`);
      out.push(Buffer.from(`${fixed.join('\r\n')}\r\n\r\n`, 'latin1'));
      if (chunked) {
        this.raw = true;
        out.push(after);
        break;
      }
      this.body = length;
      rest = after;
    }
    return Buffer.concat(out);
  }
}
