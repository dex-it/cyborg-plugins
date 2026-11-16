import type { Disposable, UiContext, UiModule } from '@cyborg-harness/contracts';

// Диалог свойств проекта (модальное окно плагина): название, описание, репозитории (порядок значим), секции других плагинов (`cyborg.project-settings`).
// Каталог выбирает диалог ядра (`projects.pick-dir`), вопрос о несохранённой правке - слой диалогов ядра. Проверка и запись - у главной части (`projects.save`):
// отказ показывается в окне, окно не закрывается.

interface Project {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly repos: readonly string[];
}
interface Field {
  readonly id: string;
  readonly kind: 'boolean' | 'text' | 'list';
  readonly label: string;
  readonly placeholder?: string;
  readonly hint?: string;
}
interface Section {
  readonly provider: string;
  readonly section: { readonly id: string; readonly title: string; readonly fields: readonly Field[] };
  readonly values: Readonly<Record<string, unknown>>;
}
interface Form {
  readonly project: Project | null;
  readonly state: { readonly projects: readonly Project[]; readonly lastProjectId: string | null };
  readonly sections: readonly Section[];
  readonly problem: { readonly text: string } | null;
}
type Input = HTMLElement & { value: string; checked: boolean; disabled: boolean; items: unknown; selected: string | undefined };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const newId = (): string => `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function mount(root: HTMLElement, ctx: UiContext): Disposable {
  const data = ctx.modal?.data as { projectId?: unknown } | undefined;
  const projectId = typeof data?.projectId === 'string' ? data.projectId : undefined;

  const el = <K extends string>(tag: K, id?: string): Input => {
    const node = document.createElement(tag) as Input;
    if (id) node.id = id;
    return node;
  };
  const button = (id: string, text: string, variant?: string): Input => {
    const b = el('cy-button', id);
    b.textContent = text;
    if (variant) b.setAttribute('variant', variant);
    return b;
  };
  const field = (id: string, label: string, placeholder = ''): Input => {
    const f = el('cy-field', id);
    f.setAttribute('label', label);
    f.setAttribute('placeholder', placeholder);
    f.value = '';
    return f;
  };

  const name = field('name', 'Название');
  const description = field('description', 'Описание');
  const reposTitle = el('h3');
  reposTitle.textContent = 'Репозитории';
  const repoList = el('cy-list', 'repos');
  repoList.setAttribute('label', 'Репозитории проекта');
  const add = button('add', 'Папка…');
  const drop = button('drop', 'Убрать');
  const up = button('up', 'Выше');
  const down = button('down', 'Ниже');
  const sectionsBox = el('div', 'sections');
  const problem = el('p', 'problem');
  problem.setAttribute('role', 'alert');
  problem.hidden = true;
  const error = el('p', 'error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const save = button('save', 'Сохранить', 'primary');
  const cancel = button('cancel', 'Отмена');
  const actions = el('div');
  actions.append(save, cancel);
  const repoBar = el('div');
  repoBar.append(add, drop, up, down);

  let form: Form | undefined;
  let repos: string[] = [];
  let chosen: string | undefined;
  /** Поле секции -> как прочитать значение из формы. */
  const readers: { section: string; field: string; read: () => unknown }[] = [];
  let initial = '';

  const showError = (text: string): void => {
    error.textContent = text;
    error.hidden = text === '';
  };
  const renderRepos = (): void => {
    repoList.items = repos.map((r) => ({ id: r, label: r.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? r, detail: r }));
    repoList.selected = chosen;
    const index = chosen === undefined ? -1 : repos.indexOf(chosen);
    drop.disabled = index < 0;
    up.disabled = index <= 0;
    down.disabled = index < 0 || index >= repos.length - 1;
  };
  const move = (by: number): void => {
    if (chosen === undefined) return;
    const from = repos.indexOf(chosen);
    const to = from + by;
    if (from < 0 || to < 0 || to >= repos.length) return;
    const next = [...repos];
    next.splice(to, 0, ...next.splice(from, 1));
    repos = next;
    renderRepos();
  };

  function buildSections(list: readonly Section[]): void {
    sectionsBox.replaceChildren();
    readers.length = 0;
    for (const { section, values } of list) {
      const title = el('h3');
      title.textContent = section.title;
      sectionsBox.append(title);
      for (const f of section.fields) {
        const value = values[f.id];
        if (f.kind === 'boolean') {
          const label = el('label');
          const box = el('input', `${section.id}-${f.id}`);
          box.setAttribute('type', 'checkbox');
          box.checked = value === true;
          label.append(box);
          const text = el('span');
          text.textContent = f.label;
          label.append(text);
          sectionsBox.append(label);
          readers.push({ section: section.id, field: f.id, read: () => box.checked });
        } else {
          const input = field(`${section.id}-${f.id}`, f.label, f.placeholder ?? '');
          input.value = f.kind === 'list' ? (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').join(', ') : '') : typeof value === 'string' ? value : '';
          sectionsBox.append(input);
          readers.push({
            section: section.id,
            field: f.id,
            read: () => (f.kind === 'list' ? input.value.split(',').map((v) => v.trim()).filter((v) => v !== '') : input.value),
          });
        }
      }
    }
  }

  const draft = (): { id: string; name: string; description: string; repos: string[]; settings: Record<string, Record<string, unknown>> } => {
    const settings: Record<string, Record<string, unknown>> = {};
    for (const r of readers) (settings[r.section] ??= {})[r.field] = r.read();
    return { id: form?.project?.id ?? '', name: name.value.trim(), description: description.value, repos: [...repos], settings };
  };

  async function onSave(): Promise<void> {
    if (!form) return;
    const d = draft();
    if (d.name === '') {
      showError('Нужно название проекта');
      return;
    }
    const id = form.project?.id ?? newId();
    const mine = { id, name: d.name, description: d.description, repos: d.repos };
    const others = form.state.projects.filter((p) => p.id !== id);
    const projects = form.project ? form.state.projects.map((p) => (p.id === id ? mine : p)) : [...others, mine];
    save.disabled = true;
    showError('');
    try {
      await ctx.commands.run('projects.save', { projects, lastProjectId: form.project ? form.state.lastProjectId : id, settings: { [id]: d.settings } });
      await ctx.modal?.close({ saved: true, id });
    } catch (e) {
      showError(messageOf(e));
    } finally {
      save.disabled = false;
    }
  }

  async function onCancel(): Promise<void> {
    if (JSON.stringify(draft()) !== initial) {
      const answer = await ctx.dialogs.show({
        kind: 'ask',
        title: 'Закрыть без сохранения?',
        message: 'Правки в свойствах проекта будут потеряны.',
        buttons: [
          { id: 'discard', label: 'Закрыть' },
          { id: 'stay', label: 'Остаться' },
        ],
      });
      if (answer !== 'discard') return;
    }
    await ctx.modal?.close({ saved: false });
  }

  add.addEventListener('click', () => {
    void ctx.commands.run('projects.pick-dir').then(
      (dir) => {
        if (typeof dir !== 'string') return;
        showError('');
        if (!repos.includes(dir)) repos = [...repos, dir];
        chosen = dir;
        renderRepos();
      },
      (e: unknown) => showError(messageOf(e)),
    );
  });
  drop.addEventListener('click', () => {
    repos = repos.filter((r) => r !== chosen);
    chosen = undefined;
    renderRepos();
  });
  up.addEventListener('click', () => move(-1));
  down.addEventListener('click', () => move(1));
  repoList.addEventListener('cy-select', (event) => {
    chosen = (event as CustomEvent<{ id: string }>).detail.id;
    renderRepos();
  });
  save.addEventListener('click', () => void onSave());
  cancel.addEventListener('click', () => void onCancel());
  // Окно открыто с `escape: 'view'`: Escape приходит виду, а несохранённая правка спрашивает подтверждение.
  const onKey = (event: Event): void => {
    if ((event as KeyboardEvent).key === 'Escape') void onCancel();
  };
  document.addEventListener('keydown', onKey);

  root.append(name, description, reposTitle, repoList, repoBar, sectionsBox, problem, error, actions);
  renderRepos();
  void ctx.commands.run('projects.form', ...(projectId === undefined ? [] : [projectId])).then(
    (value) => {
      form = value as Form;
      name.value = form.project?.name ?? '';
      description.value = form.project?.description ?? '';
      repos = [...(form.project?.repos ?? [])];
      chosen = undefined;
      problem.hidden = form.problem === null;
      problem.textContent = form.problem?.text ?? '';
      buildSections(form.sections);
      renderRepos();
      initial = JSON.stringify(draft());
    },
    (e: unknown) => {
      showError(messageOf(e));
      save.disabled = true;
    },
  );
  return {
    dispose: () => {
      document.removeEventListener('keydown', onKey);
      root.replaceChildren();
    },
  };
}

mount satisfies UiModule<HTMLElement>['mount'];
