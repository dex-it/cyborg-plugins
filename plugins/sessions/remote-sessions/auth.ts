// Доступы агента на хосте: порт src/main/remote/auth.ts ai-cyborg. Токены gh и glab оператора берутся на каждый запуск и пробуждение,
// уходят демону в stdin ssh (не в аргументы) и живут только в памяти демона и окружении процессов сессии.
import type { GitCred } from './protocol.ts';

/** gh и glab: `ctx.os.process.run` с правилами манифеста (`auth token`, `config get token`), код выхода и вывод. */
export type CliRunner = (cmd: 'gh' | 'glab', args: string[]) => Promise<{ code: number | null; stdout: string }>;

const TOKEN = /^[\x21-\x7e]{1,4096}$/;
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const HOST = /^[a-z0-9][a-z0-9.-]*$/;

/** Хост и путь репозитория из адреса origin (http, https, ssh, git, scp-форма); не разобрался - null. Порт parseRemote (src/main/trackers.ts). */
export function parseRemote(url: string): { host: string; path: string } | null {
  const text = url.trim();
  let host: string;
  let rawPath: string;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(text);
  if (scheme) {
    if (!['http', 'https', 'ssh', 'git'].includes((scheme[1] ?? '').toLowerCase())) return null;
    host = scheme[2] ?? '';
    rawPath = scheme[3] ?? '';
  } else {
    if (text.includes('://')) return null;
    const scp = /^(?:[^@/\s]+@)?([^/:\s]+):(.+)$/.exec(text);
    if (!scp) return null;
    host = scp[1] ?? '';
    rawPath = scp[2] ?? '';
  }
  host = host.toLowerCase();
  if (!HOST.test(host)) return null;
  const segments = rawPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '').split('/');
  if (!segments.every((s) => SEGMENT.test(s) && s !== '.' && s !== '..')) return null;
  return { host, path: segments.join('/') };
}

const tokenOf = async (run: CliRunner, cmd: 'gh' | 'glab', args: string[]): Promise<string> => {
  const res = await run(cmd, args).catch(() => ({ code: 1, stdout: '' }));
  const token = res.code === 0 ? res.stdout.trim() : '';
  return TOKEN.test(token) ? token : '';
};

/** Хост, которого не бывает: glab отвечает за него тем же, чем за любой хост без записи. */
const NO_SUCH_HOST = 'cyborg-no-such-host.invalid';

/** Токены хостингов origin проекта у gh и glab оператора, по запросу на каждый запуск; хост без токена пропускается - его клон идёт ключами хоста. */
export async function collectGitAuth(urls: string[], run: CliRunner): Promise<GitCred[]> {
  const hosts = [...new Set(urls.map((u) => parseRemote(u)?.host).filter((h): h is string => !!h))];
  const creds: GitCred[] = [];
  let fallback: Promise<string> | undefined;
  for (const host of hosts) {
    if (host === 'github.com') {
      const token = await tokenOf(run, 'gh', ['auth', 'token', '--hostname', host]);
      if (token) creds.push({ kind: 'github', host, token });
      continue;
    }
    // Короткий -h в новых glab (1.80, 1.130) - справка с кодом 0, а не хост.
    let gitlab = await tokenOf(run, 'glab', ['config', 'get', 'token', '--host', host]);
    // Для хоста без записи glab отдаёт корневой токен конфигурации: он не входил на этот хост и не должен ему уходить.
    if (gitlab) {
      fallback ??= tokenOf(run, 'glab', ['config', 'get', 'token', '--host', NO_SUCH_HOST]);
      if (gitlab === (await fallback)) gitlab = '';
    }
    if (gitlab) {
      creds.push({ kind: 'gitlab', host, token: gitlab });
      continue;
    }
    const enterprise = await tokenOf(run, 'gh', ['auth', 'token', '--hostname', host]);
    if (enterprise) creds.push({ kind: 'github', host, token: enterprise });
  }
  return creds;
}
