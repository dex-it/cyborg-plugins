// НОВОЕ: перезапись Host в запросах туннеля MCP (src/agentd/http-host.ts). Сервер MCP на ядре принимает только Host вида `127.0.0.1:<свой порт>`.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HostRewriter } from '../src/agentd/http-host';

const HOST = '127.0.0.1:4000';
const request = (host: string, body = '', extra = ''): string => `POST /mcp HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer T\r\n${extra}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
const run = (chunks: (string | Buffer)[]): string => {
  const rw = new HostRewriter(HOST);
  return Buffer.concat(chunks.map((c) => rw.push(Buffer.from(c)))).toString('utf8');
};

describe('HostRewriter', () => {
  it('Host заменён, остальные заголовки и тело не тронуты', () => {
    assert.equal(run([request('127.0.0.1:55555', '{"a":1}')]), request(HOST, '{"a":1}'));
    assert.equal(run([request('localhost:1', '')]), request(HOST, ''));
  });

  it('заголовок в любом регистре; Host отсутствует - добавляется; значение с «Host:» в теле не трогается', () => {
    assert.match(run(['GET /mcp HTTP/1.1\r\nhOsT:   evil\r\n\r\n']), /^GET \/mcp HTTP\/1\.1\r\nHost: 127\.0\.0\.1:4000\r\n\r\n$/);
    assert.match(run(['GET /mcp HTTP/1.1\r\nAccept: x\r\n\r\n']), /Host: 127\.0\.0\.1:4000\r\n\r\n$/);
    const body = 'Host: внутри тела\r\n\r\nещё';
    assert.equal(run([request('x:1', body)]), request(HOST, body));
  });

  it('несколько запросов на одном соединении и произвольная нарезка на куски: каждому свой Host, тело считается по Content-Length', () => {
    const all = request('a:1', 'один') + request('b:2', 'два Host: x\r\n\r\n') + request('c:3');
    const want = request(HOST, 'один') + request(HOST, 'два Host: x\r\n\r\n') + request(HOST);
    assert.equal(run([all]), want);
    const bytes = Buffer.from(all);
    for (const size of [1, 2, 3, 7, 50]) {
      const chunks: Buffer[] = [];
      for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.subarray(i, i + size));
      assert.equal(run(chunks), want, `куски по ${String(size)}`);
    }
  });

  it('chunked и Upgrade: Host исправлен, дальше соединение идёт как есть; мусор без конца заголовков не копится бесконечно', () => {
    const head = 'POST /mcp HTTP/1.1\r\nHost: a:1\r\nTransfer-Encoding: chunked\r\n\r\n';
    assert.equal(run([`${head}4\r\nабв\r\n0\r\n\r\n`]), `${head.replace('a:1', HOST)}4\r\nабв\r\n0\r\n\r\n`);
    const rw = new HostRewriter(HOST);
    const junk = Buffer.alloc(70 * 1024, 120);
    assert.deepEqual(rw.push(junk), junk, 'без конца заголовков за предел - как есть');
    assert.deepEqual(rw.push(Buffer.from('дальше')), Buffer.from('дальше'));
  });
});
