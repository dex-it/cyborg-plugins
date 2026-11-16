// НОВОЕ относительно ai-cyborg (остальные файлы этого каталога перенесены без правок): клиент демона для плагина remote-sessions.
//
// В ai-cyborg приложение держит один долгоживущий `ssh ... connect.sh` и ведёт по нему протокол строк JSON; терминал рисует окно.
// На ядре у плагина нет долгоживущего процесса со стримингом (cyborg-harness#260), а терминал - pty потребителя, поэтому те же сообщения демона
// идут двумя короткими способами, протокол при этом не меняется:
//
//   client.js rpc            строки JSON со стандартного ввода уходят демону, ответы (сообщения с rid) печатаются строками в stdout;
//                            выход, когда на каждый rid пришёл ответ (или по сроку). Один вызов `ssh host sh rpc.sh` = пачка запросов.
//   client.js attach <sid> <instance> [cols rows] [--fwd=<сокет> --upstream=<сокет> --mcp-port=<порт>]
//                            терминал сессии: вывод демона (`data`, `reset`) - в stdout, ввод - сообщениями `input`, размер - `resize`.
//                            Туннель MCP: `ssh -R <upstream>:127.0.0.1:<mcp-port>` выводит сервер MCP Cyborg на unix-сокет хоста (upstream). Клиент слушает свой сокет
//                            (--fwd, его демон берёт из hello.fwd и гонит туда запросы агента) и передаёт их на upstream, подставляя Host сервера: ядро принимает
//                            только `127.0.0.1:<свой порт>` (см. http-host.ts). Вкладка закрыта - клиент вышел - туннеля нет.
//                            Запускается как `ssh -tt host sh client.sh attach <sid> <instance>`: pty потребителя - это и есть терминал сессии.
//                            Закрытие вкладки обрывает ssh и клиент, а сессия на хосте живёт дальше (подхват - новый attach).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { HostRewriter } from './http-host';

const PROTO = 2;
const run = path.join(os.homedir(), '.cyborg', 'run');
const sock = path.join(run, 'agentd.sock');
const RPC_TIMEOUT_MS = 25_000;

type Msg = { type: string; rid?: number } & Record<string, unknown>;

/** Строки из потока: куски копятся без склейки на каждом (одна строка бывает в десятки МиБ). */
function lineReader(onLine: (line: string) => void): (chunk: Buffer) => void {
  let parts: Buffer[] = [];
  return (chunk) => {
    let start = 0;
    let nl: number;
    while ((nl = chunk.indexOf(10, start)) >= 0) {
      parts.push(chunk.subarray(start, nl));
      const line = Buffer.concat(parts).toString('utf8');
      parts = [];
      start = nl + 1;
      onLine(line);
    }
    if (start < chunk.length) parts.push(chunk.subarray(start));
  };
}

function dial(): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const socket = net.connect(sock);
    socket.once('connect', () => resolve(socket));
    socket.once('error', () => resolve(null));
  });
}

/** Сокет демона; нет демона - поднимает его из agentd.js рядом (так же, как мост connect). */
async function connect(): Promise<net.Socket> {
  let socket = await dial();
  if (!socket) {
    fs.mkdirSync(run, { recursive: true, mode: 0o700 });
    spawn(process.execPath, [path.join(__dirname, 'agentd.js'), 'serve'], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 50 && !socket; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      socket = await dial();
    }
  }
  if (!socket) {
    process.stderr.write('агент Cyborg на хосте не запустился\n');
    process.exit(1);
  }
  return socket;
}

async function rpc(): Promise<void> {
  const socket = await connect();
  const waiting = new Set<number>();
  let inputDone = false;
  let code = 0;
  const finish = (): void => {
    if (inputDone && waiting.size === 0) {
      socket.end();
      // process.exit после end: ответы уже записаны в stdout синхронно выше
      setImmediate(() => process.exit(code));
    }
  };
  const timer = setTimeout(() => {
    process.stderr.write(`демон не ответил за ${RPC_TIMEOUT_MS / 1000} с\n`);
    code = 1;
    waiting.clear();
    inputDone = true;
    finish();
  }, RPC_TIMEOUT_MS);
  timer.unref();
  socket.on('data', lineReader((line) => {
    let msg: Msg;
    try {
      msg = JSON.parse(line) as Msg;
    } catch {
      return;
    }
    // Незапрошенное (вывод, события, итоги) здесь не нужно: оно ждёт в кольце и на диске, attach заберёт его.
    if (typeof msg.rid !== 'number') return;
    process.stdout.write(line + '\n');
    waiting.delete(msg.rid);
    finish();
  }));
  socket.on('close', () => process.exit(code || (waiting.size ? 1 : 0)));
  socket.on('error', () => process.exit(1));
  process.stdin.on('data', lineReader((line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line) as Msg;
      if (typeof msg.rid === 'number') waiting.add(msg.rid);
    } catch {
      return;
    }
    socket.write(line + '\n');
  }));
  process.stdin.on('end', () => {
    inputDone = true;
    finish();
  });
}

interface Tunnel {
  /** Сокет, который слушает клиент и отдаёт демону. */
  fwd: string;
  /** Сокет `ssh -R` на хосте. */
  upstream: string;
  port: number;
}

function listenTunnel(t: Tunnel): net.Server {
  fs.rmSync(t.fwd, { force: true });
  const server = net.createServer((client) => {
    const up = net.connect(t.upstream);
    const rewrite = new HostRewriter(`127.0.0.1:${String(t.port)}`);
    client.on('data', (chunk) => up.write(rewrite.push(chunk)));
    up.pipe(client);
    client.on('error', () => up.destroy());
    up.on('error', () => client.destroy());
    client.on('close', () => up.destroy());
    up.on('close', () => client.destroy());
  });
  server.listen(t.fwd, () => fs.chmodSync(t.fwd, 0o600));
  const quit = (): void => {
    server.close();
    fs.rmSync(t.fwd, { force: true });
  };
  process.on('exit', quit);
  return server;
}

async function attach(sid: string, instance: string, size?: { cols: number; rows: number }, tunnel?: Tunnel, fwd?: string): Promise<void> {
  if (tunnel) await new Promise<void>((resolve) => listenTunnel(tunnel).once('listening', resolve));
  const socket = await connect();
  const send = (msg: Msg | Record<string, unknown>): void => void socket.write(JSON.stringify(msg) + '\n');
  const cols = (): number => size?.cols ?? process.stdout.columns ?? 80;
  const rows = (): number => size?.rows ?? process.stdout.rows ?? 24;
  let exitCode: number | undefined;
  socket.on('data', lineReader((line) => {
    let msg: Msg;
    try {
      msg = JSON.parse(line) as Msg;
    } catch {
      return;
    }
    if (msg.sid !== undefined && msg.sid !== sid) return;
    switch (msg.type) {
      case 'data':
        process.stdout.write(String(msg.data ?? ''));
        return;
      // Вытесненное из кольца: терминал сбрасывается и получает режимы, которые claude включил один раз (alt-экран, мышь).
      case 'reset':
        process.stdout.write('\x1bc' + String(msg.modes ?? ''));
        return;
      case 'exit':
        exitCode = Number(msg.code) || 0;
        process.stdout.write(`\r\n[сессия на хосте завершена, код ${String(exitCode)}${typeof msg.reason === 'string' && msg.reason ? `: ${msg.reason}` : ''}]\r\n`);
        socket.end();
        return;
      case 'ended':
        // Итог, выставленный демоном (закрытие по лимиту, сбой запуска): ack снимает его с диска.
        send({ type: 'ack', sid });
        return;
      case 'slept':
        process.stdout.write('\r\n[сессия на хосте спит: откройте её из «Истории»]\r\n');
        exitCode = 0;
        socket.end();
        return;
      case 'error':
        process.stdout.write(`\r\n[${String(msg.message ?? 'ошибка демона')}]\r\n`);
        exitCode = 1;
        socket.end();
    }
  }));
  socket.on('close', () => process.exit(exitCode ?? 0));
  socket.on('error', () => process.exit(1));
  send({ type: 'hello', proto: PROTO, instance, ...(tunnel ? { fwd: tunnel.fwd } : fwd ? { fwd } : {}), rid: 1 });
  send({ type: 'attach', sid, outFrom: 0, evFrom: Number.MAX_SAFE_INTEGER, rid: 2 });
  send({ type: 'resize', sid, cols: cols(), rows: rows() });
  process.stdout.on('resize', () => send({ type: 'resize', sid, cols: cols(), rows: rows() }));
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data: string) => send({ type: 'input', sid, data }));
  process.stdin.on('end', () => socket.end());
}

const flag = (name: string): string | undefined => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const [, , mode, sid, instance, cols, rows] = process.argv.filter((a) => !a.startsWith('--'));
const fwd = flag('fwd');
const upstream = flag('upstream');
const mcpPort = Number(flag('mcp-port'));
const tunnel: Tunnel | undefined = fwd && upstream && mcpPort > 0 && mcpPort < 65536 ? { fwd, upstream, port: mcpPort } : undefined;
if (mode === 'rpc') void rpc();
else if (mode === 'attach' && sid && instance) void attach(sid, instance, cols && rows ? { cols: Number(cols), rows: Number(rows) } : undefined, tunnel, tunnel ? undefined : fwd || undefined);
else {
  process.stderr.write('client.js rpc | attach <sid> <instance> [cols rows]\n');
  process.exit(2);
}
