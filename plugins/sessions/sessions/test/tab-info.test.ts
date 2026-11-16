// Заголовок вкладки по меткам (ai-cyborg: test/title.test.ts для окна, model.test.ts «заголовок сессии» для задач и MR) и кнопка возврата к списку (test/panel-return.test.ts).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { composeTitle, returnTarget, tabTooltip } from '../tab-info.ts';

describe('composeTitle (FR-1014, FR-2013)', () => {
  it('без привязок - заголовок как есть', () => {
    assert.equal(composeTitle('Claude Code 1', {}), 'Claude Code 1');
  });

  it('задача: «CC1 · #12 Название · открыта»; без статуса - без последней части', () => {
    assert.equal(composeTitle('CC1', { task: { key: 'k', title: '#12 Название', status: 'открыта' } }), 'CC1 · #12 Название · открыта');
    assert.equal(composeTitle('CC1', { task: { key: 'k', title: '#12 Название' } }), 'CC1 · #12 Название');
  });

  it('статус GitLab с метками workflow через запятую остаётся как дал трекер; MR идёт после задачи', () => {
    assert.equal(composeTitle('CC2', { mr: { key: 'm', title: '!7 Дерево', status: 'workflow::review, открыт' } }), 'CC2 · !7 Дерево · workflow::review, открыт');
    assert.equal(composeTitle('CC3', { task: { key: 't', title: '#1 А', status: 'открыта' }, mr: { key: 'm', title: '!2 Б', status: 'открыт' } }), 'CC3 · #1 А · открыта · !2 Б · открыт');
  });

  it('пустое название и статус не оставляют лишних разделителей', () => {
    assert.equal(composeTitle('CC1', { task: { key: 'k', title: '', status: '' } }), 'CC1');
  });
});

describe('tabTooltip', () => {
  it('заголовок, каталог и ссылки привязок построчно; пустое пропускается', () => {
    assert.equal(tabTooltip({ title: 'CC1', cwd: '/w/a', labels: { task: { key: 'k', title: 't', url: 'https://t/1' }, mr: { key: 'm', title: 'm', url: 'https://t/2' } } }), 'CC1\n/w/a\nhttps://t/1\nhttps://t/2');
    assert.equal(tabTooltip({ title: 'CC1', cwd: null, labels: {} }), 'CC1');
  });
});

describe('returnTarget (panel-return)', () => {
  it('сессия по MR ведёт на вкладку MR/PR, по задаче - на вкладку задач; подпись берёт номер из названия привязки', () => {
    assert.deepEqual(returnTarget({ mr: { key: 'k1', title: '#12 Правка' } }), { tab: 'mrs', key: 'k1', label: 'К #12 в списке', title: 'Открыть список MR/PR на #12' });
    assert.equal(returnTarget({ mr: { key: 'k2', title: '!7 Правка' } })?.label, 'К !7 в списке');
    assert.deepEqual(returnTarget({ task: { key: 't1', title: '#5 Задача' } }), { tab: 'tasks', key: 't1', label: 'К #5 в списке', title: 'Открыть список задач на #5' });
  });

  it('обычная сессия - никуда; MR важнее задачи; название без номера - подпись по ключу', () => {
    assert.equal(returnTarget({}), null);
    assert.equal(returnTarget({ task: { key: 't', title: '#1 А' }, mr: { key: 'm', title: '!2 Б' } })?.tab, 'mrs');
    assert.equal(returnTarget({ task: { key: 'PROJ-5', title: '' } })?.label, 'К PROJ-5 в списке');
  });
});
