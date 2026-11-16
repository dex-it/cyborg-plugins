// Перенос части test/mic.test.ts ai-cyborg, которая относится к демону (src/agentd/mic.ts): подставной arecord сессии. Те же утверждения.
// Не перенесено: понижение частоты и worklet окна (src/renderer/mic.ts), мост Cyborg - сокет (MicBridge) и настройка voiceHosts проекта:
// голосовой ввод откладывается (решение 12, cyborg-harness#261: микрофон кадра вида, поток вид - главная часть, сокет-сервер).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { arecord, readLine } from '../src/agentd/mic';

const tmp = (t: { after: (fn: () => void) => void }): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyb-mic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const listen = (server: net.Server, file: string): Promise<void> => new Promise((resolve) => server.listen(file, () => resolve()));

/** Весь ответ сокета после запроса: первая строка и сырой хвост. */
function ask(file: string, request: string): Promise<{ line: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(file);
    const chunks: Buffer[] = [];
    socket.on('connect', () => socket.write(request + '\n'));
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('error', reject);
    socket.on('close', () => {
      const all = Buffer.concat(chunks);
      const nl = all.indexOf(10);
      resolve({ line: all.subarray(0, nl).toString(), rest: all.subarray(nl + 1) });
    });
  });
}

describe('микрофон: подставной arecord', () => {
  it('--version успешен: так Claude Code решает, что arecord есть', async () => {
    const write = process.stdout.write;
    let out = '';
    process.stdout.write = ((s: string) => ((out += s), true)) as typeof process.stdout.write;
    try {
      assert.equal(await arecord(['--version'], {}, '/x'), 0);
    } finally {
      process.stdout.write = write;
    }
    assert.match(out, /Cyborg/);
  });

  it('проба в /dev/null и запись в файл идут через сокет; конец потока - выход 0', async (t) => {
    const dir = tmp(t);
    const sock = path.join(dir, 'mic.sock');
    const asked: string[] = [];
    const server = net.createServer((s) => {
      void readLine(s).then(({ line }) => {
        asked.push(line);
        s.end(line === 'probe' ? 'ok\n' : Buffer.concat([Buffer.from('ok\n'), Buffer.from('PCMDATA')]));
      });
    });
    t.after(() => server.close());
    await listen(server, sock);
    const env = { CYBORG_MIC: sock, PATH: '' };
    assert.equal(await arecord(['-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'raw', '/dev/null'], env, dir), 0);
    const out = path.join(dir, 'out.raw');
    assert.equal(await arecord(['-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'raw', '-q', out], env, dir), 0);
    assert.deepEqual(asked, ['probe', 'record']);
    assert.equal(fs.readFileSync(out, 'utf8'), 'PCMDATA');
  });

  it('остановка записи SIGTERM: выход 0 после того, как принятое дописано в файл', async (t) => {
    const dir = tmp(t);
    const sock = path.join(dir, 'mic.sock');
    const server = net.createServer((s) => {
      // arecord закрывает сокет по SIGTERM посреди записи: EPIPE у сервера - ожидаемый исход.
      s.on('error', () => {});
      void readLine(s).then(() => s.write(Buffer.concat([Buffer.from('ok\n'), Buffer.from('PCM'.repeat(4096))])));
    });
    t.after(() => server.close());
    await listen(server, sock);
    // SIGTERM в момент первой записи: принятое ещё в буфере потока, на диск не ушло.
    const create = fs.createWriteStream;
    t.after(() => void (fs.createWriteStream = create));
    let written = '';
    fs.createWriteStream = ((...args: Parameters<typeof create>) => {
      const stream = create(...args);
      const write = stream.write.bind(stream) as (chunk: Buffer) => boolean;
      stream.write = ((chunk: Buffer) => {
        const first = !written;
        written += chunk.toString();
        const ok = write(chunk);
        if (first) process.emit('SIGTERM');
        return ok;
      }) as typeof stream.write;
      return stream;
    }) as typeof create;
    const out = path.join(dir, 'out.raw');
    assert.equal(await arecord(['-t', 'raw', out], { CYBORG_MIC: sock, PATH: '' }, dir), 0);
    assert.ok(written.length > 0);
    assert.equal(fs.readFileSync(out, 'utf8'), written);
  });

  it('отказ без настоящего arecord - выход 1 с причиной; есть настоящий дальше по PATH - работает он', async (t) => {
    const dir = tmp(t);
    const sock = path.join(dir, 'mic.sock');
    const server = net.createServer((s) => void readLine(s).then(() => s.end('no голосовой ввод выключен\n')));
    t.after(() => server.close());
    await listen(server, sock);
    const own = path.join(dir, 'bin');
    const real = path.join(dir, 'real');
    fs.mkdirSync(own);
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(own, 'arecord'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    const err = process.stderr.write;
    let said = '';
    process.stderr.write = ((s: string) => ((said += s), true)) as typeof process.stderr.write;
    try {
      assert.equal(await arecord(['/dev/null'], { CYBORG_MIC: sock, PATH: own }, own), 1);
    } finally {
      process.stderr.write = err;
    }
    assert.match(said, /голосовой ввод выключен/);
    const mark = path.join(dir, 'ran');
    fs.writeFileSync(path.join(real, 'arecord'), `#!/bin/sh\necho "$@" > ${mark}\nexit 3\n`, { mode: 0o755 });
    assert.equal(await arecord(['-q', '/dev/null'], { CYBORG_MIC: sock, PATH: `${own}:${real}` }, own), 3);
    assert.equal(fs.readFileSync(mark, 'utf8').trim(), '-q /dev/null');
  });
});
