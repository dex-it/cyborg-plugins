// Установка демона на хост: порт src/main/remote/install.ts ai-cyborg (скрипт для `sh -s`, sha256, подмена каталога одним mv).
// Отличия от ai-cyborg: хеш считается WebCrypto (node:crypto плагину недоступен), в каталоге версии лежат ещё client.js (rpc и attach, companions/agentd/src/agentd/client.ts)
// и client.sh; версия считается по всем файлам, чтобы правка скрипта или клиента давала новый каталог на хосте.
import { LOGIN_PATH } from './preflight.ts';

/** Файл демона или клиента: имя в каталоге версии, текст и sha256 текста с переводом строки на конце (его проверяет хост). */
export interface BundleFile {
  name: string;
  source: string;
  sha256: string;
}

export interface AgentdBundle {
  /** Первые 16 hex sha256 всех файлов: изменился файл - на хосте новый каталог. */
  version: string;
  /** agentd.js первым. */
  files: BundleFile[];
}

const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** connect.sh: PATH логин-оболочки, затем мост stdio - сокет демона; демон поднимается из моста (как в ai-cyborg). */
export const CONNECT_SH = `#!/bin/sh
d=$(dirname "$0")
${LOGIN_PATH}exec node "$d/agentd.js" connect
`;

/** client.sh: тот же PATH, затем клиент демона: `rpc` или `attach <sid> <instance>` (аргументы идут как есть). */
export const CLIENT_SH = `#!/bin/sh
d=$(dirname "$0")
${LOGIN_PATH}exec node "$d/client.js" "$@"
`;

/** Файлы версии: `agentd` и `client` - тексты из ресурсов плагина. */
export async function bundleOf(agentd: string, client: string): Promise<AgentdBundle> {
  const norm = (text: string): string => text.replace(/\n+$/, '');
  const files: BundleFile[] = [];
  for (const [name, text] of [['agentd.js', agentd], ['client.js', client]] as const) {
    const source = norm(text);
    files.push({ name, source, sha256: await sha256(source + '\n') });
  }
  // Версия зависит и от скриптов запуска: они лежат в том же каталоге и ставятся вместе.
  const version = (await sha256([...files.map((f) => f.sha256), await sha256(CONNECT_SH), await sha256(CLIENT_SH)].join(':'))).slice(0, 16);
  return { version, files };
}

const delimiterFor = (...texts: string[]): string => {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const delimiter = `CYBORG_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    if (!texts.some((t) => t.includes(delimiter))) return delimiter;
  }
};

/** Скрипт установки для `sh -s`: версия собирается в скрытом каталоге, проверяется sha256 через node и встаёт на место одним mv каталога - сорванная установка видимой версии не оставляет. */
export function installScript(bundle: AgentdBundle): string {
  const d1 = delimiterFor(CONNECT_SH, CLIENT_SH, ...bundle.files.map((f) => f.source));
  const dir = `"$HOME/.cyborg/agentd/${bundle.version}"`;
  const stage = `"$HOME/.cyborg/agentd/.${bundle.version}.tmp"`;
  const put = bundle.files
    .map(
      (f) => `cat > ${stage}/${f.name} <<'${d1}'
${f.source}
${d1}
sum=$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' ${stage}/${f.name} </dev/null)
if [ "$sum" != "${f.sha256}" ]; then
  echo "контрольная сумма ${f.name} не сошлась" >&2
  exit 1
fi
`,
    )
    .join('');
  return `set -e
${LOGIN_PATH}umask 077
mkdir -p "$HOME/.cyborg/run" "$HOME/.cyborg/sessions" "$HOME/.cyborg/work" "$HOME/.cyborg/agentd"
chmod 700 "$HOME/.cyborg" "$HOME/.cyborg/run" "$HOME/.cyborg/sessions" "$HOME/.cyborg/work" "$HOME/.cyborg/agentd"
rm -rf ${stage}
trap 'rm -rf ${stage}' EXIT
mkdir ${stage}
${put}cat > ${stage}/connect.sh <<'${d1}'
${CONNECT_SH}
${d1}
cat > ${stage}/client.sh <<'${d1}'
${CLIENT_SH}
${d1}
chmod 700 ${stage}/connect.sh ${stage}/client.sh
rm -rf ${dir}
mv ${stage} ${dir}
echo installed
`;
}
