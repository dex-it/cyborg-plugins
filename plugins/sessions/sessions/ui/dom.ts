// Мелкие помощники разметки видов: стандартный элемент и элемент ядра `cy-*` (его определила оболочка вида до `mount`).

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

/** Элемент ядра (`cy-button`, `cy-empty`): свойства присваиваются как есть. */
export function cy(tag: `cy-${string}`, props: Record<string, unknown> = {}): HTMLElement {
  return Object.assign(document.createElement(tag), props);
}
