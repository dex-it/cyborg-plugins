import type { Disposable, UiContext, UiModule } from '@cyborg-harness/contracts';

// Вид «Проекты»: список проектов воркспейса, выбор, «Новый проект», «Свойства», «Удалить». Оболочка - элементы cy-*; вопросы человеку - слой диалогов ядра, не alert и confirm.
// Данные у главной части: вид просит их командами `projects.*` и перечитывает, когда она сообщила о перемене.

interface Project {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly repos: readonly string[];
}
interface Reply {
  readonly projects: readonly Project[];
  readonly lastProjectId: string | null;
  readonly problem: { readonly text: string } | null;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function mount(root: HTMLElement, ctx: UiContext): Disposable {
  const problem = document.createElement('p');
  problem.id = 'problem';
  problem.setAttribute('role', 'alert');
  problem.hidden = true;
  const list = document.createElement('cy-list') as HTMLElement & { items: unknown; selected: string | undefined };
  list.id = 'projects';
  list.setAttribute('label', 'Проекты');
  const empty = document.createElement('cy-empty');
  empty.id = 'empty';
  empty.setAttribute('heading', 'Проектов нет');
  empty.textContent = 'Создайте проект: набор репозиториев под одним именем.';
  const make = (id: string, text: string, variant?: string): HTMLElement => {
    const button = document.createElement('cy-button');
    button.id = id;
    button.textContent = text;
    if (variant) button.setAttribute('variant', variant);
    return button;
  };
  const create = make('new', 'Новый проект…');
  const edit = make('edit', 'Свойства…');
  const remove = make('remove', 'Удалить', 'danger');
  const error = document.createElement('p');
  error.id = 'error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const bar = document.createElement('div');
  bar.append(create, edit, remove);

  let reply: Reply = { projects: [], lastProjectId: null, problem: null };
  const fail = (e: unknown): void => {
    error.textContent = messageOf(e);
    error.hidden = false;
  };
  const run = (command: string, ...args: unknown[]): Promise<unknown> =>
    ctx.commands.run(command, ...args).then(
      (value) => {
        error.hidden = true;
        return value;
      },
      (e: unknown) => {
        fail(e);
        return undefined;
      },
    );

  function render(): void {
    list.items = reply.projects.map((p) => ({ id: p.id, label: p.name, detail: p.repos.length === 0 ? 'репозиториев нет' : p.repos.join(', ') }));
    list.selected = reply.lastProjectId ?? undefined;
    empty.hidden = reply.projects.length > 0;
    const none = reply.lastProjectId === null;
    (edit as HTMLElement & { disabled: boolean }).disabled = none;
    (remove as HTMLElement & { disabled: boolean }).disabled = none;
    problem.hidden = reply.problem === null;
    problem.textContent = reply.problem?.text ?? '';
  }
  async function reload(): Promise<void> {
    const value = (await run('projects.load')) as Reply | undefined;
    if (value) {
      reply = value;
      render();
    }
  }

  list.addEventListener('cy-select', (event) => {
    const id = (event as CustomEvent<{ id: string }>).detail.id;
    void run('projects.select', id).then(reload);
  });
  create.addEventListener('click', () => void run('projects.new').then(reload));
  edit.addEventListener('click', () => {
    if (reply.lastProjectId !== null) void run('projects.edit', reply.lastProjectId).then(reload);
  });
  remove.addEventListener('click', () => {
    const target = reply.projects.find((p) => p.id === reply.lastProjectId);
    if (!target) return;
    void ctx.dialogs
      .show({
        kind: 'ask',
        title: `Удалить проект «${target.name}»?`,
        message: 'Каталоги репозиториев останутся на диске, исчезнет только проект.',
        buttons: [
          { id: 'remove', label: 'Удалить' },
          { id: 'cancel', label: 'Отмена' },
        ],
      })
      .then((answer) => (answer === 'remove' ? run('projects.remove', target.id).then(reload) : undefined));
  });

  const channel = ctx.channel.onMessage(() => void reload());
  const visible = ctx.onVisibilityChange((v) => {
    if (v) void reload();
  });
  root.append(problem, list, empty, bar, error);
  void reload();
  return {
    dispose: () => {
      channel.dispose();
      visible.dispose();
      root.replaceChildren();
    },
  };
}

mount satisfies UiModule<HTMLElement>['mount'];
