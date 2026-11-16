// Бюджеты времени (решение D-00, п. 9): не хуже базы на 10%, мера - медиана; сравнение относительное, без абсолютных порогов.
// База - то, что делал ai-cyborg: те же запуски git без плагина и шлюза (`execFile` из процесса теста). Образцы идут вперемешку (плагин, база, плагин, ...),
// чтобы нагрузка машины ложилась на обе стороны поровну. Числа печатаются в вывод теста; допуск сверх 10% - шум самого запуска процесса (SLACK_MS).
// Бюджет `onChange`: не позже 5 мс на p99 после склейки событий шлюза (50 мс), замер как в PL-04 - цена плагина сверх голого слежения за тем же каталогом.
//
// Два режима. По умолчанию (общий прогон, CI): мягкий - замеров больше, берётся медиана минимумов пачек (шум раннера только удлиняет замер, а не укорачивает),
// допуск широкий: тест ловит только грубую регрессию (вдвое и хуже), а числа печатает. `CYBORG_BUDGET=strict` - допуск D-00, п. 9: 10% по медиане и 5 мс на p99; он
// измеряется на тихой машине локально (`CYBORG_BUDGET=strict npm test --workspace plugins/code/git -- ...` или `node --test test/budget.test.ts`), раннер CI слишком шумный.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import type { PluginContext } from '@cyborg-harness/contracts';
import type { InlinePlugin } from '@cyborg-harness/testing';
import { FILTER_CONFIG_ARGS, FILES_ARGS, LS_STAGE_ARGS, ROOT_ARGS, SAFE_ARGS, STATUS_ARGS } from '../args.ts';
import { repo, rig } from './kit.ts';

const run = promisify(execFile);
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
/** Запуск ai-cyborg: `git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C <каталог> ...` (SAFE_CONFIG), без `--no-optional-locks`. */
const base = (cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = {}) => run('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { env: { ...ENV, ...env }, maxBuffer: 64 * 1024 * 1024 });

const STRICT = process.env.CYBORG_BUDGET === 'strict';
const SAMPLES = STRICT ? 25 : 40;
/** Машина, на которой идут тесты, не тихая (рядом чужие процессы): замер, не уложившийся в бюджет, повторяется, и считается нарушением, только если не уложились все попытки. */
const ATTEMPTS = STRICT ? 3 : 1;

async function withinBudget(t: { diagnostic(message: string): void }, name: string, measure: () => Promise<{ ok: boolean; line: string }>): Promise<void> {
  const lines: string[] = [];
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const { ok, line } = await measure();
    t.diagnostic(`${name} (попытка ${String(attempt)}): ${line}`);
    lines.push(line);
    if (ok) return;
  }
  assert.fail(`${name}: бюджет не выдержан за ${String(ATTEMPTS)} попытки: ${lines.join(' | ')}`);
}
/** Допуск сверх 10%: один запуск процесса дрожит на миллисекунды, а на коротких операциях 10% - доли миллисекунды. */
const SLACK_MS = 3;

/** Минимумы пачек по пять образцов, затем медиана: нагрузка раннера удлиняет отдельные замеры, но не укорачивает, поэтому минимум пачки ближе к цене самой операции. */
const medianOfMinima = (values: readonly number[]): number => median(Array.from({ length: Math.floor(values.length / 5) }, (_, i) => Math.min(...values.slice(i * 5, i * 5 + 5))));
const median = (values: readonly number[]): number => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? NaN;
const quantile = (values: readonly number[], q: number): number => values.toSorted((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(q * values.length) - 1)] ?? NaN;
const round = (n: number): number => Math.round(n * 10) / 10;
async function time(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

/** То, что делал `gitStatus` ai-cyborg, но с теми же запусками, что у плагина: ключи фильтров, индекс, затем status. */
async function baseStatus(dir: string): Promise<void> {
  await Promise.all([base(dir, FILTER_CONFIG_ARGS, { LC_ALL: 'C' }).catch(() => undefined), base(dir, LS_STAGE_ARGS)]);
  await base(dir, STATUS_ARGS, { GIT_CONFIG_COUNT: '0' });
}

describe('git: бюджеты', () => {
  it('запросы плагина через шлюз не хуже запусков ai-cyborg на 10% по медиане (status, root, files)', async (t) => {
    using r = repo({ files: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`src/f${String(i)}.ts`, `export const x${String(i)} = ${String(i)};\n`])) });
    await using k = await rig({ repos: [r.dir], noWrap: true });
    r.write('src/f1.ts', 'changed\n');
    r.write('new.txt', 'n\n');
    const cases: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
      ['status', () => k.git.status(r.dir), () => baseStatus(r.dir)],
      ['root', () => k.git.root(r.dir), () => base(r.dir, ROOT_ARGS)],
      ['files', () => k.git.files(r.dir), () => base(r.dir, FILES_ARGS)],
    ];
    for (const [name, plugin, baseline] of cases) {
      for (let i = 0; i < 3; i++) {
        await plugin();
        await baseline();
      }
      await withinBudget(t, name, async () => {
        const mine: number[] = [];
        const theirs: number[] = [];
        for (let i = 0; i < SAMPLES; i++) {
          mine.push(await time(plugin));
          theirs.push(await time(baseline));
        }
        const [m, b] = STRICT ? [median(mine), median(theirs)] : [medianOfMinima(mine), medianOfMinima(theirs)];
        return {
          ok: STRICT ? m <= b * 1.1 + SLACK_MS : m <= b * 2 + 5,
          line: `${STRICT ? 'строго, медиана' : 'мягко, медиана минимумов'}: плагин ${String(round(m))} мс, p99 ${String(round(quantile(mine, 0.99)))} мс; база p50 ${String(round(b))} мс, p99 ${String(round(quantile(theirs, 0.99)))} мс; отношение ${String(round((m / b) * 100) / 100)}`,
        };
      });
    }
  });

  it('onChange: цена плагина сверх голого слежения за тем же .git не больше 5 мс на p99 (после склейки шлюза в 50 мс)', async (t) => {
    using withPlugin = repo({ files: { 'a.txt': 'a\n' } });
    using bare = repo({ files: { 'a.txt': 'a\n' } });
    // Голое слежение: плагин, который отдаёт те же события из того же `fs.watch` без разбора и состояния, - всё, что делает любой потребитель границы плагинов.
    const bareEvents: number[] = [];
    const baseline: InlinePlugin = {
      manifest: { id: 'bare', version: '1.0.0', engines: { cyborg: '^1' }, permissions: { 'fs.read': ['workspace'] }, commands: { 'bare.watch': { args: ['string'] } } },
      module: {
        activate(ctx: PluginContext) {
          ctx.commands.register('bare.watch', async (dir) => {
            await ctx.os.fs.watch(`${String(dir)}/.git`, (names) => void ((names.includes('HEAD') || names.includes('index')) && bareEvents.push(performance.now())));
          });
          return undefined;
        },
      },
    };
    await using k = await rig({ repos: [withPlugin.dir, bare.dir], noWrap: true, extra: [baseline] });
    const mine: number[] = [];
    await k.git.onChange(withPlugin.dir, () => void mine.push(performance.now()));
    await k.kernel.run('bare.watch', bare.dir);
    /** Время первого события после `before`-го; события одной пачки (индекс, голова) идут подряд, нужен только первый. */
    const wait = async (list: number[], before: number): Promise<number> => {
      const end = Date.now() + 5000;
      while (list.length <= before) {
        if (Date.now() > end) assert.fail('событие не пришло');
        await new Promise((r) => setTimeout(r, 1));
      }
      return list[before] ?? NaN;
    };
    // Событие вызывает перезапись головного файла: состояние репозитория не меняется, а имя `HEAD` из перечня и плагина, и голого слежения.
    const touch = async (dir: string, _i: number): Promise<void> => {
      const head = (await run('git', ['-C', dir, 'symbolic-ref', 'HEAD'], { env: ENV })).stdout.trim();
      await run('git', ['-C', dir, 'symbolic-ref', 'HEAD', head], { env: ENV });
    };
    // Слежение FSEvents начинает доставку позже возврата `watch`: прогрев, пока оба слушателя не откликнутся; хвост пачки дожидается паузой.
    const sample = async (dir: string, list: number[], i: number): Promise<number> => {
      await new Promise((r) => setTimeout(r, 150));
      const before = list.length;
      await touch(dir, i);
      const done = performance.now();
      return (await wait(list, before)) - done;
    };
    /** Слежение начинает доставку позже возврата `watch`: головной файл переписывается, пока слушатель не отзовётся. */
    const arm = async (dir: string, list: number[]): Promise<void> => {
      const end = Date.now() + 10_000;
      const head = (await run('git', ['-C', dir, 'symbolic-ref', 'HEAD'], { env: ENV })).stdout.trim();
      while (list.length === 0) {
        if (Date.now() > end) assert.fail(`слежение за ${dir} не отозвалось за 10 с`);
        await run('git', ['-C', dir, 'symbolic-ref', 'HEAD', head], { env: ENV });
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    await arm(withPlugin.dir, mine);
    await arm(bare.dir, bareEvents);
    await new Promise((resolve) => setTimeout(resolve, 400));
    for (let i = 0; i < 3; i++) {
      await sample(withPlugin.dir, mine, 100 + i);
      await sample(bare.dir, bareEvents, 100 + i);
    }
    await withinBudget(t, 'onChange от конца команды до слушателя', async () => {
      const dMine: number[] = [];
      const dBare: number[] = [];
      for (let i = 0; i < SAMPLES; i++) {
        dMine.push(await sample(withPlugin.dir, mine, i));
        dBare.push(await sample(bare.dir, bareEvents, i));
      }
      const [pm, pb] = [quantile(dMine, 0.99), quantile(dBare, 0.99)];
      const p50 = median(dMine) - median(dBare);
      return {
        ok: STRICT ? pm - pb <= 5 && p50 <= 5 : pm - pb <= 30 && p50 <= 15,
        line: `плагин p50 ${String(round(median(dMine)))} мс, p99 ${String(round(pm))} мс; голое слежение p50 ${String(round(median(dBare)))} мс, p99 ${String(round(pb))} мс; цена плагина p50 ${String(round(p50))} мс, p99 ${String(round(pm - pb))} мс`,
      };
    });
  });
});

