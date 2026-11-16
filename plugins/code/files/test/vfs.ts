// Виртуальная файловая система для тестов модели дерева: те же ответы `OsFs`, что у шлюза (`list`, `stat`, `watch` с `recursive`), но события приходят, когда их шлёт тест.
// Так проверяется разбор событий (маршрут по узлам, лавина, потерянные события) без ОС: FSEvents на macOS и inotify на Linux ведут себя по-разному, а модель от этого не зависит.
// Что делает настоящая ОС и настоящий шлюз, проверяют тесты на настоящем ядре (watch.test.ts).

import type { Disposable, DirEntry, FileStat, OsFs } from '@cyborg-harness/contracts';

type Node = { kind: 'dir' } | { kind: 'file' } | { kind: 'link'; to: string | null };

const coded = (code: string, text: string): Error => Object.assign(new Error(text), { code });

export interface WatchHandle {
  readonly path: string;
  readonly recursive: boolean;
  disposed: boolean;
  readonly listener: (names: readonly string[]) => void;
  readonly onClose: ((reason: string) => void) | undefined;
}

export class Vfs {
  private readonly nodes = new Map<string, Node>();
  readonly watches: WatchHandle[] = [];
  readonly calls = { list: 0, stat: 0, watch: 0 };
  /** Запрещённые каталоги: чтение даёт `PermissionDenied`, как путь вне `workspace`. */
  readonly denied = new Set<string>();
  /** Задержка ответа, мс: для тестов гонок. */
  delay = 0;

  constructor(tree: Record<string, 'dir' | 'file' | { link: string | null }> = {}) {
    for (const [path, kind] of Object.entries(tree)) this.put(path, kind);
  }

  put(path: string, kind: 'dir' | 'file' | { link: string | null } = 'file'): void {
    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const parent = `/${parts.slice(0, i).join('/')}`;
      if (!this.nodes.has(parent)) this.nodes.set(parent, { kind: 'dir' });
    }
    this.nodes.set(path, typeof kind === 'string' ? { kind } : { kind: 'link', to: kind.link });
  }

  remove(path: string): void {
    for (const key of [...this.nodes.keys()]) if (key === path || key.startsWith(`${path}/`)) this.nodes.delete(key);
  }

  /** Событие слежения за корнем: имена от корня через `/`. */
  emit(root: string, ...names: string[]): void {
    for (const w of this.watches) if (!w.disposed && w.path === root) w.listener(names);
  }

  /** Слежение закрыто ядром (каталог удалён, права ушли). */
  close(root: string, reason: string): void {
    for (const w of this.watches) if (!w.disposed && w.path === root) w.onClose?.(reason);
  }

  live(): number {
    return this.watches.filter((w) => !w.disposed).length;
  }

  private async tick(): Promise<void> {
    if (this.delay > 0) await new Promise((resolve) => setTimeout(resolve, this.delay));
    else await Promise.resolve();
  }

  private resolve(path: string): Node | undefined {
    let node = this.nodes.get(path);
    for (let hops = 0; node?.kind === 'link' && hops < 8; hops++) node = node.to === null ? undefined : this.nodes.get(node.to);
    return node?.kind === 'link' ? undefined : node;
  }

  private checkReadable(path: string): void {
    for (const d of this.denied) if (path === d || path.startsWith(`${d}/`)) throw coded('PermissionDenied', `вне области fs.read: ${path}`);
  }

  async list(dir: string): Promise<DirEntry[]> {
    this.calls.list++;
    await this.tick();
    this.checkReadable(dir);
    const node = this.resolve(dir);
    if (node === undefined) throw coded('NotFound', `нет каталога ${dir}`);
    if (node.kind !== 'dir') throw coded('Invalid', `${dir} не каталог`);
    const out: DirEntry[] = [];
    for (const [path, n] of this.nodes) {
      if (!path.startsWith(`${dir}/`) || path.slice(dir.length + 1).includes('/')) continue;
      out.push({ name: path.slice(dir.length + 1), kind: n.kind });
    }
    return out;
  }

  async stat(path: string): Promise<FileStat> {
    this.calls.stat++;
    await this.tick();
    this.checkReadable(path);
    const own = this.nodes.get(path);
    const node = this.resolve(path);
    if (own === undefined) throw coded('NotFound', `нет ${path}`);
    if (node === undefined) throw coded('NotFound', `ссылка ${path} висит`);
    return { kind: node.kind === 'dir' ? 'dir' : 'file', size: 0, mtimeMs: 0 };
  }

  async watch(path: string, listener: (names: readonly string[]) => void, onClose?: (reason: string) => void, options?: { recursive?: boolean }): Promise<Disposable> {
    this.calls.watch++;
    await this.tick();
    this.checkReadable(path);
    const handle: WatchHandle = { path, recursive: options?.recursive === true, disposed: false, listener, onClose };
    this.watches.push(handle);
    return { dispose: () => void (handle.disposed = true) };
  }

  /** Как OsFs для модели дерева: ей нужны только list, stat, watch. */
  get fs(): OsFs {
    return this as unknown as OsFs;
  }
}
