// Каждый запуск, который поставщик `cyborg.agent` описывает правилом `launch`, обязан быть разрешён правилом `pty` у `sessions`:
// ядро пропускает запуск, только если он подходит под оба (SAD, `describedBy`). Без этого теста поставщик, чей запуск `sessions` не
// разрешает, обнаруживается только при первой настоящей сессии («программа не в pty: ssh»).

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

type Rule = string | { program: string; args: string[]; env?: string[]; deny?: string[] };
interface Manifest {
  id: string;
  provides?: Record<string, unknown>;
  permissions?: { pty?: Rule[]; launch?: Rule[] };
}

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const manifests = (): Manifest[] =>
  readdirSync(root).flatMap((cat) =>
    !existsSync(path.join(root, cat)) || !statSync(path.join(root, cat)).isDirectory()
      ? []
      : readdirSync(path.join(root, cat)).flatMap((id) => {
          const file = path.join(root, cat, id, 'manifest.json');
          return existsSync(file) ? [JSON.parse(readFileSync(file, 'utf8')) as Manifest] : [];
        }),
  );

const asObject = (r: Rule): { program: string; args: string[]; env: string[] } => (typeof r === 'string' ? { program: r, args: [], env: [] } : { program: r.program, args: r.args, env: r.env ?? [] });

/** Правило `pty` покрывает правило `launch`: та же программа, закреплённые аргументы `launch` начинаются с закреплённых аргументов `pty`, окружение `launch` названо в `pty`. */
const covers = (pty: Rule, launch: Rule): boolean => {
  const p = asObject(pty);
  const l = asObject(launch);
  return p.program === l.program && p.args.every((a, i) => l.args[i] === a) && l.env.every((e) => p.env.includes(e));
};

describe('правила pty у sessions покрывают запуски поставщиков cyborg.agent', () => {
  const all = manifests();
  const sessions = all.find((m) => m.id === 'sessions');
  const providers = all.filter((m) => m.provides && 'cyborg.agent' in m.provides);

  it('поставщики cyborg.agent в репозитории найдены', () => {
    assert.ok(sessions, 'нет плагина sessions');
    assert.ok(providers.length >= 2, `поставщиков: ${providers.map((p) => p.id).join(', ')}`);
  });

  for (const provider of providers) {
    it(`${provider.id}: каждое правило launch разрешено правилом pty у sessions`, () => {
      const pty = sessions?.permissions?.pty ?? [];
      for (const launch of provider.permissions?.launch ?? []) {
        // Служебный запуск «вывести подсказку и выйти» (`$SHELL -lc echo …`) терминал не открывает: он идёт через ту же оболочку входа, что и claude.
        const label = typeof launch === 'string' ? launch : `${launch.program} ${launch.args.slice(0, 3).join(' ')}`;
        const shellHint = typeof launch !== 'string' && launch.program === '$SHELL' && launch.args[1]?.startsWith('echo ');
        if (shellHint) continue;
        assert.ok(
          pty.some((rule) => covers(rule, launch)),
          `у sessions нет правила pty для запуска ${provider.id}: ${label}`,
        );
      }
    });
  }
});
