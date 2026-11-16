import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkPlugin } from '@cyborg-harness/core/plugin-check';
import type { PluginModule } from '@cyborg-harness/contracts';
import { startKernel, type InlinePlugin } from '@cyborg-harness/testing';
import { ISOLATION_PROMPT } from '../index.ts';

const home = path.resolve(import.meta.dirname, '..');
const reference = readFileSync(path.join(import.meta.dirname, 'fixtures', 'isolation-prompt.txt'));

/**
 * Клон ai-cyborg на якорном коммите 6fd308f: переменная AI_CYBORG_DIR, `.ai-cyborg` в корне репозитория (так клонирует CI)
 * или каталог `ai-cyborg-src` / `ai-cyborg` в самом репозитории или его родителях. Нет клона - сверка пропускается.
 */
function findAiCyborg(): string | undefined {
  const candidates = process.env.AI_CYBORG_DIR ? [process.env.AI_CYBORG_DIR] : [];
  for (let dir = home; path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    candidates.push(path.join(dir, '.ai-cyborg'), path.join(dir, 'ai-cyborg-src'), path.join(dir, 'ai-cyborg'));
  }
  return candidates.find((c) => existsSync(path.join(c, 'src/main/claude-args.ts')));
}

/** Потребитель, устроенный как `sessions` пилота ядра: фрагменты всех поставщиков, порядок по id плагина, пустые отброшены, сбой поставщика не мешает. */
const sessionsLike: InlinePlugin = {
  manifest: {
    id: 'sessions',
    version: '1.0.0',
    engines: { cyborg: '^1' },
    consumes: { 'cyborg.session-prompt': '^1' },
    commands: { 'sessions.prompt': {} },
  },
  module: {
    activate(ctx) {
      ctx.commands.register('sessions.prompt', async () => {
        const all = ctx.contracts.all('cyborg.session-prompt', 1).toSorted((a, b) => a.pluginId.localeCompare(b.pluginId));
        const texts = await Promise.all(all.map((p) => p.impl.fragment().catch(() => '')));
        return texts.filter((t) => t.trim() !== '').join('\n\n');
      });
      return undefined;
    },
  } satisfies PluginModule,
};

/** Второй поставщик с тем же id, что у владельца кнопок ai-cyborg (`next-actions`, его `SUGGEST_PROMPT`): в тесте его текст - заглушка. */
const SUGGEST_STUB = 'ЗАГЛУШКА кнопок от модели';
const nextActionsStub: InlinePlugin = {
  manifest: { id: 'next-actions', version: '1.0.0', engines: { cyborg: '^1' }, provides: { 'cyborg.session-prompt': '1.0' } },
  module: {
    activate(ctx) {
      ctx.contracts.provide('cyborg.session-prompt', '1.0', { fragment: () => SUGGEST_STUB });
      return undefined;
    },
  } satisfies PluginModule,
};

describe('плагин session-isolation', () => {
  it('проверка состава: манифест, файлы, правило импортов - без замечаний, прав не просит', async () => {
    const report = await checkPlugin(home, { ignore: ['dist'] });
    assert.deepEqual(report.problems, []);
    assert.deepEqual(report.permissions, []);
  });

  it('FR-9001: фрагмент совпадает с эталонным текстом побайтно (UTF-8, без перевода строки в конце)', () => {
    assert.equal(reference.length, 793, 'эталон - 793 байта');
    assert.ok(Buffer.from(ISOLATION_PROMPT, 'utf8').equals(reference));
    assert.equal(reference.at(-1), '.'.charCodeAt(0), 'эталон не заканчивается переводом строки');
    assert.ok(!reference.includes(0x0d), 'в эталоне нет возврата каретки');
  });

  it('FR-9001: фрагмент совпадает с ISOLATION_PROMPT из клона ai-cyborg', (t) => {
    const clone = findAiCyborg();
    if (clone === undefined) {
      t.skip('клона ai-cyborg нет (AI_CYBORG_DIR, .ai-cyborg, ai-cyborg-src): сверка с исходной константой пропущена, эталон проверен отдельным тестом');
      return;
    }
    const source = readFileSync(path.join(clone, 'src/main/claude-args.ts'), 'utf8');
    const found = /export const ISOLATION_PROMPT =\s*'([^'\n]*)';/.exec(source);
    assert.ok(found?.[1], 'в claude-args.ts не нашлась константа ISOLATION_PROMPT: поменялась форма записи');
    assert.ok(!found[1].includes('\\'), 'в исходной строке появились экранирующие последовательности: сравнение надо делать иначе');
    assert.ok(Buffer.from(found[1], 'utf8').equals(Buffer.from(ISOLATION_PROMPT, 'utf8')));
  });

  it('содержательные утверждения эталона: EnterWorktree, основной каталог только чтение, --add-dir, git worktree add', () => {
    const text = reference.toString('utf8');
    assert.match(text, /Перед первой правкой в репозитории, сменой ветки или коммитом - EnterWorktree/);
    assert.match(text, /основной каталог - только чтение/);
    assert.match(text, /Файлы вне репозиториев \(скрэтчпад, временные\) worktree не требуют/);
    assert.match(text, /из --add-dir - git worktree add <репозиторий>\/\.claude\/worktrees\/<то же имя> -b <та же ветка>/);
  });

  it('поставщик cyborg.session-prompt: потребитель получает фрагмент изоляции, это единственное, что плагин отдаёт', async () => {
    await using kernel = await startKernel({ plugins: [home, sessionsLike] });
    await kernel.waitForJournal({ kind: 'activated', pluginId: 'session-isolation' });
    await kernel.waitForJournal({ kind: 'activated', pluginId: 'sessions' });
    assert.equal(await kernel.run('sessions.prompt'), ISOLATION_PROMPT);
  });

  it('плагин отключён (plugins.enabled без него): в составном промпте фрагмента изоляции нет', async () => {
    await using kernel = await startKernel({ plugins: [home, nextActionsStub, sessionsLike], enabled: ['next-actions', 'sessions'] });
    await kernel.waitForJournal({ kind: 'activated', pluginId: 'sessions' });
    assert.equal(await kernel.run('sessions.prompt'), SUGGEST_STUB);
  });

  it('порядок при двух поставщиках: по id плагина, то есть next-actions раньше session-isolation (в ai-cyborg изоляция первая; до cyborg-harness#259 это расхождение)', async () => {
    await using kernel = await startKernel({ plugins: [home, nextActionsStub, sessionsLike] });
    await kernel.waitForJournal({ kind: 'activated', pluginId: 'sessions' });
    const composed = await kernel.run('sessions.prompt');
    // Фактическое поведение ядра сейчас: порядок задаёт id плагина-поставщика.
    assert.equal(composed, `${SUGGEST_STUB}\n\n${ISOLATION_PROMPT}`);
    // Порядок ai-cyborg (SESSION_PROMPT = ISOLATION_PROMPT + SUGGEST_PROMPT) этим набором пока не воспроизводится.
    assert.notEqual(composed, `${ISOLATION_PROMPT}\n\n${SUGGEST_STUB}`);
    // Порядок регистрации плагинов на результат не влияет: тот же набор - тот же промпт.
    await using reversed = await startKernel({ plugins: [sessionsLike, nextActionsStub, home] });
    await reversed.waitForJournal({ kind: 'activated', pluginId: 'sessions' });
    assert.equal(await reversed.run('sessions.prompt'), composed);
  });
});
