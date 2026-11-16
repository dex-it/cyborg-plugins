// Сервер MCP сессий на настоящем ядре (фича 15, M-04): `agent-claude-code` пишет конфиг и отдаёт токен процессу, `sessions` держит сервер по праву `serve`.
// Терминал - `fakePty()`, хуки Claude Code изображает запись строки JSON в файл событий. Настоящего `claude` в тестах нет: клиент MCP тесты играют сами по конфигу запуска.
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { PARALLEL_PROMPT } from '../delegate.ts';
import { claudeArgs, rig, settle, until, type Proc, type Rig } from './kit.ts';
import { echoTool, mcpOf, textsUnder, type Mcp } from './mcp-kit.ts';

const exists = (file: string): Promise<boolean> => access(file).then(() => true, () => false);

/** Сессия пришла в «работает»: агент слушает файл событий, первые строки прочитаны. */
async function working(r: Rig, proc: Proc): Promise<void> {
  await r.armed(proc);
}

/** Человек открыл сессию с двумя репозиториями проекта и она «работает». */
async function human(r: Rig): Promise<{ proc: Proc; mcp: Mcp; sessionId: string }> {
  const { sessionId } = await r.sessions.create({ cwd: r.repoA, addDirs: [r.repoB] });
  const proc = r.last();
  await working(r, proc);
  return { proc, mcp: await mcpOf(proc), sessionId };
}

test('FR-15001, FR-15002: сессия подключена к серверу своим конфигом - http на 127.0.0.1 и токен в окружении; протокол JSON-RPC в POST /mcp без SSE', async () => {
  await using r = await rig();
  const { proc, mcp } = await human(r);
  const flag = proc.args.find((a) => a.startsWith('--mcp-config='));
  assert.ok(flag, '--mcp-config= через «=»: ключ вариадический и иначе забрал бы запрос');
  const config = JSON.parse(await readFile(flag.slice('--mcp-config='.length), 'utf8'));
  assert.deepEqual(Object.keys(config.mcpServers), ['cyborg']);
  assert.equal(config.mcpServers.cyborg.type, 'http');
  assert.match(config.mcpServers.cyborg.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.equal(config.mcpServers.cyborg.headers.Authorization, 'Bearer ${CYBORG_MCP_TOKEN}', 'в конфиге ссылка на переменную, а не значение токена');
  assert.match(mcp.token, /^[\w-]{43}$/);

  const init = await mcp.rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.serverInfo.name, 'cyborg');
  assert.equal((await mcp.post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  assert.deepEqual(await mcp.rpc('ping'), { jsonrpc: '2.0', id: 2, result: {} });
  const get = await mcp.post(undefined, mcp.headers, 'GET');
  assert.equal(get.status, 405, 'потока SSE нет');
  r.clean();
});

test('NFR-15001: без токена, с чужим и после выхода сессии - 401; Origin страницы и чужой Host ядро не пускает до сервера', async () => {
  await using r = await rig();
  const { proc, mcp } = await human(r);
  const bare = { 'content-type': 'application/json' };
  const call = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  assert.equal((await mcp.post(call, bare)).status, 401);
  assert.equal((await mcp.post(call, { ...bare, authorization: 'Bearer chuzhoy' })).status, 401);
  assert.equal((await mcp.post(call, { ...bare, authorization: `Bearer ${'x'.repeat(43)}` })).status, 401);
  const origin = await fetch(mcp.url, { method: 'POST', headers: { ...mcp.headers, origin: 'https://evil.example' }, body: JSON.stringify(call) });
  assert.equal(origin.status, 403, 'страница в браузере дотянется до 127.0.0.1, но всегда шлёт Origin');
  assert.equal((await fetch(mcp.url.replace('/mcp', '/другой'), { method: 'POST', headers: mcp.headers, body: '{}' })).status, 404);
  assert.equal((await mcp.post(call)).status, 200);
  proc.exit(0);
  await until('токен отозван на выходе', async () => (await mcp.post(call)).status === 401);
});

test('токен сессии не попадает в аргументы командной строки, файлы данных, журнал ядра и плагина, документы, состояние (аналог T-05 ядра)', async () => {
  await using r = await rig();
  const first = await human(r);
  await r.sessions.create({ cwd: r.repoB });
  const second = r.last();
  const others = await mcpOf(second);
  const tokens = [first.mcp.token, others.token];
  assert.notEqual(tokens[0], tokens[1], 'у каждой сессии свой токен');
  // Что видно рядом: вызовы, ответы, ошибки - чтобы токен успел пройти через все места.
  await first.mcp.tool('list_sessions');
  await first.mcp.tool('нет такого').catch(() => undefined);
  await first.mcp.post({ jsonrpc: '2.0', id: 9, method: 'tools/list' }, { authorization: 'Bearer plokhoy' });
  const seen = [
    ...[first.proc, second].flatMap((p) => p.args),
    JSON.stringify(r.kernel.journal),
    JSON.stringify(r.kernel.documents),
    r.logs.join('\n'),
    JSON.stringify(await r.run('sessions.running')),
    JSON.stringify(await r.run('sessions.family')),
    ...(await textsUnder(r.dataRoot)).map((f) => f.text),
    ...(await textsUnder(r.home)).map((f) => f.text),
  ];
  for (const token of tokens) {
    seen.forEach((text, i) => assert.ok(!text.includes(token), `токен найден в источнике ${String(i)}: ${text.slice(0, 80)}`));
    for (const proc of [first.proc, second]) {
      const where = Object.entries(proc.options.env).filter(([, v]) => v === token).map(([k]) => k);
      assert.ok(where.length <= 1, 'в окружении токен только под одним именем');
    }
  }
  assert.equal(first.proc.options.env.CYBORG_MCP_TOKEN, tokens[0], 'токен идёт переменной окружения процесса');
  assert.ok((await textsUnder(r.dataRoot)).length > 0, 'каталог данных не пуст: проверка не вхолостую');
  r.clean();
});

test('инструменты: у сессии, открытой человеком, четыре своих, у каждой каталоги её проекта; инструменты поставщиков cyborg.agent-tool - тем же сервером', async () => {
  const calls: { name: string; input: unknown; sessionId: string }[] = [];
  await using r = await rig({ extra: [echoTool(calls)] });
  const { mcp, sessionId } = await human(r);
  const tools = await mcp.tools();
  assert.deepEqual(tools.map((t) => t.name), ['open_session', 'list_sessions', 'send_to_session', 'close_session', 'echo', 'boom'], 'чужое имя, подделка под свой инструмент и плохое имя отброшены');
  assert.deepEqual(tools[0].inputSchema.properties.repo.enum, [r.repoA, r.repoB]);
  assert.ok(r.logs.some((m) => m.includes('open_session отброшен') || m.includes('open_session') && m.includes('занято')), 'причина отброса в журнале плагина');
  assert.ok(r.logs.some((m) => m.includes('без пробелов нельзя')));

  const echo = await mcp.tool('echo', { text: 'привет' });
  assert.deepEqual(echo, { text: `эхо ${sessionId}: привет`, isError: false });
  assert.deepEqual(calls, [{ name: 'echo', input: { text: 'привет' }, sessionId }]);
  assert.deepEqual(await mcp.tool('boom'), { text: 'не вышло', isError: true });
  // Кнопки инструмента: очищены от управляющих символов, ждут человека у плагина.
  assert.deepEqual(await r.run('sessions.actions', sessionId), [{ label: 'Ещё', text: 'ещё раз', submit: true }]);
  // Подделка не вызывается: берётся свой open_session (ошибка проверки аргументов, а не вызов поставщика).
  const fake = await mcp.tool('open_session', {});
  assert.equal(fake.isError, true);
  assert.equal(calls.length, 2);
  assert.equal(((await mcp.rpc('tools/call', { name: 'нет', arguments: {} })) as any).error.code, -32602);
});

test('без поставщиков инструментов сессия всё равно получает свои четыре', async () => {
  await using r = await rig();
  const { mcp } = await human(r);
  assert.deepEqual((await mcp.tools()).map((t) => t.name), ['open_session', 'list_sessions', 'send_to_session', 'close_session']);
});

test('S19, FR-15003, FR-15004: open_session открывает вкладку в фоне, задание - первым сообщением; ключ и промпт интерфейсу не видны', async () => {
  const reveals: string[] = [];
  await using r = await rig({ load: { onDocumentReveal: (id) => void reveals.push(id) } });
  const parent = await human(r);
  const secret = 'СЕКРЕТНОЕ-ЗАДАНИЕ-7f3a';
  const answer = await parent.mcp.tool('open_session', { prompt: ` ${secret} \n`, repo: r.repoB });
  assert.equal(answer.isError, false, answer.text);
  assert.equal(answer.text, `Открыта вкладка сессии 2 в ${r.repoB}.`);

  const child = r.last();
  assert.notEqual(child, parent.proc);
  assert.equal(child.options.cwd, r.repoB, 'рабочий каталог - выбранный repo');
  assert.deepEqual(claudeArgs(child).slice(-3), [secret, '--add-dir', r.repoA], 'задание - первым сообщением до --add-dir, остальные каталоги проекта подключены');
  assert.equal(child.args.some((a) => a === ` ${secret} \n`), false, 'края промпта обрезаны');
  assert.deepEqual(reveals, [], 'вкладка открыта в фоне: текущая остаётся активной');
  assert.equal(r.kernel.documents.length, 2);
  // Что видит интерфейс: документы вкладок, ответы команд, события контракта, журналы. Задания и ключа передачи там нет.
  const ui = JSON.stringify([r.kernel.documents, await r.run('sessions.running'), await r.run('sessions.family'), await r.run('sessions.previous'), r.events, r.logs, r.kernel.journal]);
  assert.ok(!ui.includes(secret), 'промпт дочерней не виден интерфейсу');
  assert.ok(!/handoff|hid/i.test(ui.replace(/session:handoff/g, '')), 'ключа передачи интерфейсу нет');

  // Дочерняя: инструмент report_done у неё есть, у родителя нет; её родитель и семья - в данных вкладки и в `sessions.family`.
  const childMcp = await mcpOf(child);
  assert.ok((await childMcp.tools()).some((t) => t.name === 'report_done'));
  assert.ok(!(await parent.mcp.tools()).some((t) => t.name === 'report_done'));
  const family = (await r.run('sessions.family')) as { sessionId: string; label: string; parent?: string; family: string }[];
  assert.deepEqual(family.map((f) => [f.label, f.family === parent.sessionId]), [['CC1', true], ['CC2 ↳1', true]]);
  assert.equal(family[1]?.parent, parent.sessionId);
  r.clean();
});

test('FR-15005, FR-15006: list_sessions - вкладки проекта с состоянием по событиям агента и хвостом ответа', async () => {
  await using r = await rig();
  const parent = await human(r);
  const other = await r.sessions.create({ cwd: r.repoB });
  const foreign = r.last();
  // Вкладка другого проекта (иной набор каталогов запуска) в перечне не видна; запускающаяся - starting.
  const peers = async (): Promise<any[]> => JSON.parse((await parent.mcp.tool('list_sessions')).text) as any[];
  assert.deepEqual((await peers()).map((p) => [p.id, p.tab, p.self === true, p.state]), [[1, 'CC1', true, 'working']]);
  const same = await r.sessions.create({ cwd: r.repoA, addDirs: [r.repoB] });
  assert.equal(same.title, 'Claude Code 3');
  const peer = r.last();
  assert.deepEqual(((await peers()) as any[]).map((p) => [p.id, p.state]), [[1, 'working'], [3, 'starting']]);
  await working(r, peer);
  await r.hook(peer, { hook_event_name: 'Stop', last_assistant_message: 'готово: ' + 'я'.repeat(2000) });
  await until('ждёт', async () => (await peers()).find((p) => p.id === 3)?.state === 'waiting');
  const waiting = (await peers()).find((p) => p.id === 3);
  assert.equal(waiting.repo, r.repoA);
  assert.equal(waiting.cwd, r.repoA);
  assert.equal(waiting.last_answer.length, 1501, 'хвост последнего ответа: 1500 знаков и «…» перед ним');
  assert.ok(waiting.last_answer.startsWith('…'));
  await r.hook(peer, { hook_event_name: 'UserPromptSubmit' });
  await r.hook(peer, { hook_event_name: 'Notification', notification_type: 'permission_prompt' });
  await until('на вопросе', async () => (await peers()).find((p) => p.id === 3)?.state === 'asking');
  assert.equal((await peers()).find((p) => p.id === 3).reason, 'Просит разрешение');
  await r.hook(peer, { hook_event_name: 'PostToolUse', cwd: '/moved', tool_name: 'Bash' });
  await until('снова работает', async () => (await peers()).find((p) => p.id === 3)?.state === 'working');
  assert.equal((await peers()).find((p) => p.id === 3).cwd, '/moved');
  assert.ok(other.sessionId && foreign);
});

test('S19, FR-15007, FR-15008: send_to_session отказывает, пока сессия запускается или стоит на вопросе; работающей - в очередь до конца хода; ждущей - вставкой и Enter', async () => {
  await using r = await rig();
  const parent = await human(r);
  await r.sessions.create({ cwd: r.repoA, addDirs: [r.repoB] });
  const peer = r.last();
  const send = (id: number, message: string) => parent.mcp.tool('send_to_session', { id, message });
  // Запускается: SessionStart ещё не пришёл.
  const starting = await send(2, 'рано');
  assert.equal(starting.isError, true);
  assert.match(starting.text, /ещё запускается/);
  await working(r, peer);
  // Работает: в очередь Cyborg.
  const queued = await send(2, 'первое\r\nвторое');
  assert.equal(queued.isError, false);
  assert.match(queued.text, /в очереди Cyborg/);
  assert.deepEqual(JSON.parse((await parent.mcp.tool('list_sessions')).text).find((p: any) => p.id === 2).queued, 1);
  assert.deepEqual(peer.writes, [], 'в работающую вкладку ничего не пишется');
  // Ход закончился: после тишины в 2 с сообщение уходит вставкой и Enter отдельной записью.
  await r.hook(peer, { hook_event_name: 'Stop' });
  await until('сообщение доставлено', () => peer.writes.length === 2, 6000);
  assert.deepEqual(peer.writes, ['\x1b[200~первое\nвторое\x1b[201~', '\r']);
  // Новый запрос человека запускает ход; на вопросе сессии ей не пишут и не ставят в очередь.
  await r.hook(peer, { hook_event_name: 'UserPromptSubmit' });
  await r.hook(peer, { hook_event_name: 'Notification', notification_type: 'permission_prompt' });
  await until('на вопросе', async () => JSON.parse((await parent.mcp.tool('list_sessions')).text).find((p: any) => p.id === 2)?.state === 'asking');
  const asking = await send(2, 'не сейчас');
  assert.equal(asking.isError, true);
  assert.match(asking.text, /Просит разрешение/);
  // Слэш-команды, «!» и «#», себе и несуществующей вкладке - отказ.
  for (const [id, message, re] of [[2, '/permissions', /«\/» или «#»/], [2, '!ls', /«!»/], [1, 'x', /этой же/], [9, 'x', /нет среди открытых/]] as const) {
    const refused = await send(id, message);
    assert.equal(refused.isError, true, message);
    assert.match(refused.text, re);
  }
  assert.equal(peer.writes.length, 2, 'ни одного лишнего байта в чужую вкладку');
  r.clean();
});

test('S19, FR-15009: close_session без force не обрывает работу и вопрос соседки; с force закрывает; ждущую и свою дочернюю - без force', async () => {
  await using r = await rig();
  const parent = await human(r);
  await r.sessions.create({ cwd: r.repoA, addDirs: [r.repoB] });
  const sibling = r.last();
  await working(r, sibling);
  const close = (id: number, force?: boolean) => parent.mcp.tool('close_session', { id, ...(force !== undefined && { force }) });
  const docs = r.kernel.documents.map((d) => d.id);

  const busy = await close(2);
  assert.equal(busy.isError, true);
  assert.match(busy.text, /работает.*force: true/);
  assert.equal(sibling.killed, undefined, 'процесс не тронут');
  assert.equal(r.kernel.documents.length, 2, 'вкладка на месте');
  await r.hook(sibling, { hook_event_name: 'Notification', notification_type: 'permission_prompt' });
  await until('на вопросе', async () => JSON.parse((await parent.mcp.tool('list_sessions')).text).find((p: any) => p.id === 2)?.state === 'asking');
  assert.match((await close(2)).text, /ждёт человека \(Просит разрешение\)/);
  assert.equal(sibling.killed, undefined);
  assert.equal((await parent.mcp.tool('close_session', { id: 2, force: 'да' })).isError, true);

  const forced = await close(2, true);
  assert.deepEqual(forced, { text: 'Вкладка сессии 2 закрыта.', isError: false });
  assert.ok(sibling.killed, 'процесс завершён');
  assert.equal(r.kernel.documents.length, 1, 'вкладка убрана');
  assert.ok(docs.includes(r.kernel.documents[0]?.id ?? ''));
  assert.equal(JSON.parse((await parent.mcp.tool('list_sessions')).text).length, 1);
  assert.equal((await close(2)).isError, true, 'номера больше нет среди вкладок проекта');

  // Ждущую соседку закрывают без force.
  await r.sessions.create({ cwd: r.repoA, addDirs: [r.repoB] });
  const waiting = r.last();
  await working(r, waiting);
  await r.hook(waiting, { hook_event_name: 'Stop' });
  await until('ждёт', async () => JSON.parse((await parent.mcp.tool('list_sessions')).text).find((p: any) => p.tab === 'CC3')?.state === 'waiting');
  assert.match((await close(3)).text, /закрыта/);
  assert.ok(waiting.killed);

  // Свою дочернюю родитель закрывает в любом состоянии без force, внучку - как чужую.
  await parent.mcp.tool('open_session', { prompt: 'дочерняя', repo: r.repoA });
  const child = r.last();
  await working(r, child);
  const childMcp = await mcpOf(child);
  await childMcp.tool('open_session', { prompt: 'внучка', repo: r.repoA });
  const grand = r.last();
  await working(r, grand);
  const list = JSON.parse((await parent.mcp.tool('list_sessions')).text) as any[];
  const [childId, grandId] = [list.find((p) => p.child === true)?.id, list.find((p) => p.parent !== undefined && p.child === undefined)?.id];
  assert.ok(childId && grandId);
  assert.match((await close(grandId)).text, /работает.*force: true/);
  assert.match((await close(childId)).text, /закрыта/);
  assert.ok(child.killed);
  r.clean();
});

test('S19: close_session своей вкладки - после ответа, через секунду', async () => {
  await using r = await rig();
  const parent = await human(r);
  const answer = await parent.mcp.tool('close_session', { id: 1 });
  assert.equal(answer.text, 'Эта вкладка закроется через секунду.');
  assert.equal(parent.proc.killed, undefined, 'ответ дошёл раньше закрытия');
  await until('вкладка закрыта', () => parent.proc.killed !== undefined, 4000);
  assert.equal(r.kernel.documents.length, 0);
});

test('FR-15010: report_done дочерней идёт открывшей сессии сообщением; один итог за круг, новый круг - после запроса; открывшей нет - уведомление', async () => {
  await using r = await rig();
  const parent = await human(r);
  await parent.mcp.tool('open_session', { prompt: 'задание', repo: r.repoA });
  const child = r.last();
  await working(r, child);
  const childMcp = await mcpOf(child);
  const bad = await childMcp.tool('report_done', { status: 'готово', summary: 'x' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /status/);
  assert.equal((await childMcp.tool('report_done', { status: 'ok', summary: 'x', branch: '-плохая' })).isError, true);
  const ok = await childMcp.tool('report_done', { status: 'ok', summary: 'сделано', branch: 'feat-x', pr: 'https://example.com/pr/1' });
  assert.match(ok.text, /Итог принят/);
  const again = await childMcp.tool('report_done', { status: 'ok', summary: 'ещё' });
  assert.equal(again.isError, true);
  assert.match(again.text, /уже отправлен/);
  // Родитель работает: итог ждёт конца хода и тишины, потом приходит вставкой.
  assert.deepEqual(parent.proc.writes, []);
  await r.hook(parent.proc, { hook_event_name: 'Stop' });
  await until('итог доставлен родителю', () => parent.proc.writes.length === 2, 6000);
  assert.deepEqual(parent.proc.writes, ['\x1b[200~Итог сессии CC2: ok\nветка: feat-x\nPR: https://example.com/pr/1\n\nсделано\x1b[201~', '\r']);
  // Новый круг: запрос человека дочерней.
  await r.hook(child, { hook_event_name: 'UserPromptSubmit' });
  await r.hook(parent.proc, { hook_event_name: 'UserPromptSubmit' });
  await until('круг открыт', async () => (await childMcp.tool('report_done', { status: 'blocked', summary: 'нужен человек' })).isError === false);
  // Родитель закрыт: итог некому прийти, остаётся уведомление.
  await r.run('sessions.kill', parent.sessionId);
  parent.proc.exit(0);
  await until('родитель вышел', () => r.events.some((e) => e.sessionId === parent.sessionId && e.change.type === 'exit'));
  await r.hook(child, { hook_event_name: 'UserPromptSubmit' });
  await until('круг открыт', async () => (await childMcp.tool('report_done', { status: 'failed', summary: 'родителя нет' })).isError === false);
  r.clean();
});

test('токен отзывается, когда сессия вышла или вкладку закрыл человек; открытый вызов вышедшей сессии - ошибка', async () => {
  await using r = await rig();
  const first = await human(r);
  const second = await human(r);
  const [doc] = r.kernel.documents;
  assert.ok(doc);
  await r.kernel.closeDocument(doc.id);
  await until('токен закрытой человеком вкладки отозван', async () => (await first.mcp.post({ jsonrpc: '2.0', id: 1, method: 'ping' })).status === 401);
  assert.equal((await second.mcp.post({ jsonrpc: '2.0', id: 1, method: 'ping' })).status, 200, 'токен соседки жив');
  second.proc.exit(1);
  await until('токен вышедшей отозван', async () => (await second.mcp.post({ jsonrpc: '2.0', id: 1, method: 'ping' })).status === 401);
  const config = second.proc.args.find((a) => a.startsWith('--mcp-config='))?.slice('--mcp-config='.length) ?? '';
  await until('конфиг MCP убран агентом на выходе', async () => !(await exists(config)));
});

test('открытие не удалось: причина возвращается вызвавшей модели (канал session:handoffFailed), вкладки и процесса нет', async () => {
  await using r = await rig();
  const parent = await human(r);
  // Проект изменился после запуска родителя: репозиторий больше не принимается, а в схеме инструмента он ещё есть.
  r.projects.repos = [r.repoA];
  const failed = await parent.mcp.tool('open_session', { prompt: 'задание', repo: r.repoB });
  assert.equal(failed.isError, true);
  assert.match(failed.text, /Каталог не входит в репозитории проектов/);
  assert.equal(r.pty.procs.length, 1, 'новый процесс не запускался');
  assert.equal(r.kernel.documents.length, 1);
  // Негодное задание и каталог вне схемы не доходят до открытия.
  for (const [prompt, repo, re] of [['', r.repoA, /непустая/], ['-ключ', r.repoA, /«-»/], ['!ls', r.repoA, /«!»/], ['x', '/etc', /один из каталогов проекта/]] as const) {
    const refused = await parent.mcp.tool('open_session', { prompt, repo });
    assert.equal(refused.isError, true);
    assert.match(refused.text, re);
  }
  assert.equal(r.pty.procs.length, 1);
});

test('хост плагина перезапущен, pty живы: дочерняя сохраняет родителя и семью; сервер встаёт заново, токены прошлого сервера не действуют, а новая сессия видит подхваченных', async () => {
  await using r = await rig({ os: { ptyOrphanGrace: 150 } });
  const parent = await human(r);
  await parent.mcp.tool('open_session', { prompt: 'задание', repo: r.repoA });
  const child = r.last();
  await r.kernel.disable('sessions', { keepPty: true });
  await r.kernel.enable('sessions');
  await settle(300);
  assert.equal(child.killed, undefined);
  const family = (await r.run('sessions.family')) as { label: string; family: string; sessionId: string }[];
  assert.deepEqual(family.map((f) => f.label), ['CC1', 'CC2 ↳1'], 'номера из заголовков вкладок, родитель - из документа');
  assert.equal(family[0]?.family, family[1]?.family);
  // Порт сервера выбирает ОС: прежний сервер ушёл вместе с хостом, оставленные сессии свой конфиг больше не открывают (ограничение, README).
  await assert.rejects(parent.mcp.rpc('ping'), /fetch failed|ECONNREFUSED|connect/);
  // Новая сессия получает новый сервер и видит подхваченных: их состояние станет известно по первому событию.
  const fresh = (await r.run('sessions.create', { cwd: r.repoA, addDirs: [r.repoB] })) as { sessionId: string };
  const mcp = await mcpOf(r.last());
  assert.notEqual(mcp.url, parent.mcp.url);
  const list = JSON.parse((await mcp.tool('list_sessions')).text) as any[];
  assert.deepEqual(list.map((p) => [p.tab, p.state, p.child ?? p.parent ?? null]), [['CC1', 'starting', null], ['CC2', 'starting', 1], ['CC3', 'starting', null]]);
  assert.equal(list.find((p) => p.tab === 'CC3').self, true);
  const refused = await mcp.tool('send_to_session', { id: 1, message: 'рано' });
  assert.equal(refused.isError, true, 'подхваченной сессии без событий не пишут');
  assert.match(refused.text, /ещё запускается/);
  assert.ok(fresh.sessionId);
});

test('вкладку, открытую инструментом, может вернуть восстановление: родитель и семья остаются в данных вкладки', async () => {
  await using r = await rig();
  const parent = await human(r);
  await parent.mcp.tool('open_session', { prompt: 'задание', repo: r.repoA });
  const child = r.last();
  child.exit(0);
  await until('вышла', async () => ((await r.run('sessions.running')) as unknown[]).length === 1);
  const previous = (await r.run('sessions.previous')) as { id: string }[];
  assert.equal(previous.length, 1);
  await r.run('sessions.restore', previous[0]?.id);
  const restored = r.last();
  assert.notEqual(restored, child);
  const family = (await r.run('sessions.family')) as { label: string }[];
  assert.deepEqual(family.map((f) => f.label), ['CC1', 'CC2 ↳1']);
});

test('повод к делегированию и плагин Claude Code: системный промпт дописан последним, скилл и хук записаны в каталог данных и подключены --plugin-dir', async () => {
  await using r = await rig();
  const { proc } = await human(r);
  const flag = proc.args.find((a) => a.startsWith('--plugin-dir='));
  assert.ok(flag, 'ключ плагина Claude Code в запуске');
  const dir = flag.slice('--plugin-dir='.length);
  assert.ok(dir.startsWith(r.kernel.dataDir('sessions')), 'каталог - данные плагина sessions');
  assert.ok(proc.args.indexOf(flag) < proc.args.indexOf('--append-system-prompt'), 'ключ стоит перед аргументами claude');
  const prompt = proc.args[proc.args.indexOf('--append-system-prompt') + 1] ?? '';
  assert.ok(prompt.endsWith(PARALLEL_PROMPT), 'повод - последним фрагментом');
  assert.ok(PARALLEL_PROMPT.includes('cyborg:parallel-sessions'));

  const manifest = JSON.parse(await readFile(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'cyborg', 'скилл виден как cyborg:parallel-sessions');
  const skill = await readFile(path.join(dir, 'skills', 'parallel-sessions', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: parallel-sessions\n/);
  for (const tool of ['open_session', 'list_sessions', 'send_to_session', 'close_session', 'report_done']) assert.ok(skill.includes(tool), tool);
  const hooks = JSON.parse(await readFile(path.join(dir, 'hooks', 'hooks.json'), 'utf8'));
  assert.equal(hooks.hooks.PostToolUse[0].hooks[0].command, 'bash "${CLAUDE_PLUGIN_ROOT}/hooks/lsp-reap.sh" 2>/dev/null || true');
  assert.ok(await exists(path.join(dir, 'hooks', 'lsp-reap.sh')));
  // Все ресурсы на месте без `.txt` и без бита исполнения: хук зовётся как `bash <файл>`.
  const files = (await textsUnder(dir)).map((f) => path.relative(dir, f.file)).sort();
  assert.deepEqual(files, ['.claude-plugin/plugin.json', '.installed', 'hooks/hooks.json', 'hooks/lsp-reap.sh', 'skills/parallel-sessions/SKILL.md']);
  r.clean();
});

test('ресурсы плагина записываются один раз: вторая сессия берёт тот же каталог, среда агента не получает лишних переменных', async () => {
  await using r = await rig();
  await r.sessions.create({ cwd: r.repoA });
  const first = r.last();
  await r.sessions.create({ cwd: r.repoB });
  const second = r.last();
  const dir = (p: Proc) => p.args.find((a) => a.startsWith('--plugin-dir='));
  assert.equal(dir(first), dir(second));
  assert.deepEqual(Object.keys(second.options.env).filter((k) => k.startsWith('CYBORG_')).sort(), ['CYBORG_EVENTS', 'CYBORG_MCP_TOKEN', 'CYBORG_SETTINGS']);
  assert.equal(await exists(path.join(r.dataRoot, 'sessions', 'child-sessions.json')), false, 'у сессий человека перечня дочерних нет');
});

test('дочерняя запоминается в перечне разговоров: первое событие сессии пишет child-sessions.json, sessions.children отдаёт номера для «Истории»', async () => {
  await using r = await rig();
  const parent = await human(r);
  await parent.mcp.tool('open_session', { prompt: 'задание', repo: r.repoA });
  const child = r.last();
  await working(r, child);
  const uuid = '33333333-3333-3333-3333-333333333333';
  await r.hook(child, { hook_event_name: 'SessionStart', session_id: uuid });
  await until('номер записан', async () => ((await r.run('sessions.children')) as string[]).includes(uuid));
  assert.deepEqual(JSON.parse(await readFile(path.join(r.dataRoot, 'sessions', 'child-sessions.json'), 'utf8')), [uuid]);
  const own = '44444444-4444-4444-4444-444444444444';
  await r.hook(parent.proc, { hook_event_name: 'SessionStart', session_id: own });
  await settle(150);
  assert.deepEqual(await r.run('sessions.children'), [uuid], 'разговор самостоятельной сессии в перечень не идёт');
});

test('вид получает сообщения о поручении и закрытии: без задания и без ключа, и перечитывает вкладки', async () => {
  const sent: { type?: string }[] = [];
  await using r = await rig({ load: { onViewMessage: (plugin, view, message) => void (plugin === 'sessions' && view === 'main' && sent.push(message as { type?: string })) } });
  const parent = await human(r);
  const secret = 'ЗАДАНИЕ-ДЛЯ-ВИДА-91c2';
  await parent.mcp.tool('open_session', { prompt: secret, repo: r.repoA });
  const childId = ((await r.run('sessions.family')) as { sessionId: string }[])[1]?.sessionId;
  await until('сообщение о поручении', () => sent.some((m) => m.type === 'session:handoff'));
  assert.deepEqual(sent.find((m) => m.type === 'session:handoff'), { type: 'session:handoff', from: 1, sessionId: childId, number: 2 });
  const tabsBefore = sent.filter((m) => m.type === 'tabs').length;
  await parent.mcp.tool('close_session', { id: 2 });
  await until('сообщение о закрытии', () => sent.some((m) => m.type === 'session:close'));
  assert.deepEqual(sent.find((m) => m.type === 'session:close'), { type: 'session:close', sessionId: childId, number: 2 });
  await until('толчок перечитать вкладки', () => sent.filter((m) => m.type === 'tabs').length > tabsBefore);
  assert.ok(!JSON.stringify(sent).includes(secret), 'задание виду не уходит');
  assert.ok(!JSON.stringify(sent).includes(parent.mcp.token), 'токен виду не уходит');
});
