// Туннель подставного ssh (`ssh -R <сокет>:127.0.0.1:<порт>`): слушает unix-сокет «хоста» и гонит соединения на порт этой машины.
// Выходит, когда исчез процесс ssh (pid третьим аргументом): подставной ssh исполняет команду через exec, pid тот же.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const [sock, port, owner] = process.argv.slice(2);
if (!sock || !port || !owner) process.exit(2);
fs.mkdirSync(path.dirname(sock), { recursive: true });
fs.rmSync(sock, { force: true });
const server = net.createServer((client) => {
  const up = net.connect(Number(port), '127.0.0.1');
  client.pipe(up);
  up.pipe(client);
  client.on('error', () => up.destroy());
  up.on('error', () => client.destroy());
  client.on('close', () => up.destroy());
  up.on('close', () => client.destroy());
});
server.listen(sock);
const quit = () => {
  server.close();
  fs.rmSync(sock, { force: true });
  process.exit(0);
};
setInterval(() => {
  try {
    process.kill(Number(owner), 0);
  } catch {
    quit();
  }
}, 200);
process.on('SIGTERM', quit);
