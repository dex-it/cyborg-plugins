// НОВОЕ: клиент демона для плагина remote-sessions (`client.js rpc` и `client.js attach`, src/agentd/client.ts). Проверяется собранный файл из ресурсов плагина:
// ровно то, что плагин кладёт на хост. Демон - настоящий (Daemon из ai-cyborg) с подставными процессами, сокет - как у agentd.ts `serve`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { lineReader } from '../src/agentd/agentd';
import { RING_BYTES, type Msg } from '../src/agentd/protocol';
import { client, rig, until, type Rig } from './daemon-rig';

const CLIENT_JS = path.resolve(process.env.COMPANION_ROOT ?? '', '../../plugins/sessions/remote-sessions/assets/agentd/client.js.txt');
const SID = 'aaaaaaaa-1111-2222-3333-444444444444';

type T = { after: (fn: () => void) => void };

/** Демон на сокете `~/.cyborg/run/agentd.sock` стенда: так его находит клиент. */
function serve(t: T, r: Rig): void {
  const sock = path.join(r.home, '.cyborg', 'run', 'agentd.sock');
  const server = net.createServer((socket) => {
    const conn = r.daemon.connect({ send: (msg) => void socket.write(JSON.stringify(msg) + '\n') });
    socket.on('data', lineReader((line) => conn.receive(JSON.parse(line) as Msg)));
    socket.on('close', () => conn.close());
    socket.on('error', () => socket.destroy());
  });
  server.listen(sock);
  t.after(() => server.close());
}

/** Клиент в отдельном процессе с домашним каталогом стенда; stdout копится, stdin остаётся открытым. */
function run(t: T, r: Rig, args: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-cl-'));
  const file = path.join(dir, 'client.js');
  fs.copyFileSync(CLIENT_JS, file);
  const child = spawn(process.execPath, [file, ...args], { env: { PATH: process.env.PATH ?? '', HOME: r.home }, stdio: 'pipe' });
  const out = { text: '', err: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d: string) => (out.text += d));
  child.stderr.on('data', (d: string) => (out.err += d));
  const exit = new Promise<number | null>((resolve) => child.on('close', resolve));
  t.after(() => {
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { child, out, exit };
}

const spawnMsg = { type: 'spawn', rid: 2, sid: SID, token: 'T'.repeat(43), repos: [{ local: '/loc/a', url: 'git@h:o/a.git', name: 'a' }], selected: 0, branch: 'feat', origin: 'human', keep: false, limits: { maxPerHost: 4, taskMs: 14_400_000, idleMs: 1_800_000 }, cols: 120, rows: 40 };

/** Живая сессия на демоне стенда: процесс подставной, вывод пишет тест. */
async function live(r: Rig) {
  const c = client();
  const conn = r.daemon.connect(c);
  conn.receive({ type: 'hello', rid: 1, proto: 2, instance: 'inst-1' });
  conn.receive(spawnMsg as Msg);
  await until(() => r.procs.length > 0);
  // Окно закрылось, как после обрыва: вывод копится в кольце, клиент заберёт его через attach.
  conn.close();
  return r.procs[0];
}

const mkRig = (t: T): Rig => rig(t, {}, fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-ad-')));

describe('client.js rpc: пачка запросов одним вызовом', () => {
  it('строки JSON со stdin уходят демону, ответы с rid печатаются строками, выход - когда ответили на всё', async (t) => {
    const r = mkRig(t);
    serve(t, r);
    const cl = run(t, r, ['rpc']);
    cl.child.stdin.write('{"type":"hello","proto":2,"instance":"i1","rid":1}\n{"type":"list","rid":2}\n');
    cl.child.stdin.end();
    assert.equal(await cl.exit, 0, cl.out.err);
    const replies = cl.out.text.trim().split('\n').map((l) => JSON.parse(l) as Msg);
    assert.deepEqual(replies.map((m) => [m.type, m.rid]), [['hello', 1], ['list', 2]]);
    assert.equal(replies[0]?.proto, 2);
    assert.deepEqual(replies[1]?.sessions, []);
  });

  it('ошибка демона приходит ответом error с тем же rid; запрос без rid и не-JSON пропускаются, не ломая остальное', async (t) => {
    const r = mkRig(t);
    serve(t, r);
    const cl = run(t, r, ['rpc']);
    cl.child.stdin.write('не json\n\n{"type":"list"}\n{"type":"attach","sid":"нет","rid":7}\n');
    cl.child.stdin.end();
    assert.equal(await cl.exit, 0, cl.out.err);
    const replies = cl.out.text.trim().split('\n').map((l) => JSON.parse(l) as Msg);
    assert.equal(replies.length, 1, 'ответ только на запрос с rid');
    assert.deepEqual([replies[0]?.type, replies[0]?.rid, replies[0]?.message], ['error', 7, 'сессия на хосте не найдена']);
  });

  it('spawn через rpc: ответ с клонами приходит, а сессия остаётся жить на демоне после закрытия соединения', async (t) => {
    const r = mkRig(t);
    r.answers['ls-remote'] = { code: 2 };
    serve(t, r);
    const cl = run(t, r, ['rpc']);
    cl.child.stdin.write(`{"type":"hello","proto":2,"instance":"i1","rid":1}\n${JSON.stringify(spawnMsg)}\n`);
    cl.child.stdin.end();
    assert.equal(await cl.exit, 0, cl.out.err);
    const reply = JSON.parse(cl.out.text.trim().split('\n')[1] ?? '{}') as Msg;
    assert.equal(reply.sid, SID);
    await until(() => r.procs.length === 1);
    assert.equal(r.daemon.liveCount(), 1, 'закрытие rpc не убивает сессию');
  });
});

describe('client.js attach: терминал сессии', () => {
  it('вывод из кольца и живой вывод - в stdout, ввод - в процесс сессии, размер - stty демона; выход процесса закрывает клиент с сообщением', async (t) => {
    const r = mkRig(t);
    r.answers['ls-remote'] = { code: 2 };
    serve(t, r);
    const proc = await live(r);
    proc.emit('до подключения\r\n');
    // tty сессии записывает launch.sh под script; здесь - как будто записал.
    fs.writeFileSync(path.join(r.home, '.cyborg', 'sessions', SID, 'tty'), '/dev/pts/9');
    const cl = run(t, r, ['attach', SID, 'inst-1', '100', '30']);
    await until(() => cl.out.text.includes('до подключения'));
    proc.emit('живой вывод\r\n');
    await until(() => cl.out.text.includes('живой вывод'));
    cl.child.stdin.write('ls -la\r');
    await until(() => proc.written.join('').includes('ls -la\r'));
    proc.exit(0);
    assert.equal(await cl.exit, 0, cl.out.err);
    assert.match(cl.out.text, /\[сессия на хосте завершена, код 0\]/);
    assert.ok(r.execs.some((e) => e.file === 'stty' && e.args.join(' ') === '-F /dev/pts/9 rows 30 cols 100'), 'размер терминала клиента дошёл до pty сессии на хосте');
  });

  it('сессии нет - сообщение в терминале и код 1; чужое окно - отказ демона тем же путём', async (t) => {
    const r = mkRig(t);
    serve(t, r);
    const cl = run(t, r, ['attach', 'bbbbbbbb-1111-2222-3333-444444444444', 'inst-1']);
    assert.equal(await cl.exit, 1);
    assert.match(cl.out.text, /\[сессия на хосте не найдена\]/);
  });

  it('вытесненное из кольца: терминал сбрасывается (RIS) и получает режимы, включённые один раз, затем идёт хвост', async (t) => {
    const r = mkRig(t);
    r.answers['ls-remote'] = { code: 2 };
    serve(t, r);
    const proc = await live(r);
    proc.emit('\x1b[?1049h');
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < RING_BYTES / chunk.length + 4; i++) proc.emit(chunk);
    proc.emit('хвост');
    const cl = run(t, r, ['attach', SID, 'inst-1', '80', '24']);
    await until(() => cl.out.text.includes('хвост'));
    assert.ok(cl.out.text.startsWith('\x1bc\x1b[?1049h'), JSON.stringify(cl.out.text.slice(0, 20)));
    proc.exit(0);
    await cl.exit;
  });

  it('без аргументов клиент подсказывает вызов и выходит кодом 2', async (t) => {
    const r = mkRig(t);
    const cl = run(t, r, ['attach']);
    assert.equal(await cl.exit, 2);
    assert.match(cl.out.err, /client\.js rpc \| attach/);
  });
});
