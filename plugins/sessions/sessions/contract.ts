import type { PluginContext } from '@cyborg-harness/contracts';
import type { SessionBindingKind, SessionCreateRequest, SessionsV12 } from '@cyborg-plugins/contracts';
import { validateCreateInput, validateLabelsPatch, validateSessionId } from './args.ts';
import type { Input } from './input.ts';
import type { Launcher } from './launcher.ts';
import type { Registry } from './registry.ts';

/** Версия контракта: 1.1 - `onChange`, `reveal`; 1.2 добавляет `create`, `send`, `paste`, метки (`labels`, `setLabels`, `find`) и `uses`. */
export const CONTRACT_VERSION = '1.2';

/** Что приходит от чужого плагина, проверяется: типы через границу плагинов не гарантированы. */
export function createContract(ctx: PluginContext, registry: Registry, launcher: Launcher, input: Input): SessionsV12 {
  const idOf = (value: unknown): string => {
    const id = validateSessionId(value);
    if (id === null) throw new Error('id сессии не годится');
    return id;
  };
  const kindOf = (value: unknown): SessionBindingKind => {
    if (value !== 'task' && value !== 'mr') throw new Error('вид привязки: task или mr');
    return value;
  };
  return {
    onChange: (listener) => registry.onChange(listener),
    async reveal(sessionId) {
      const tab = registry.get(idOf(sessionId));
      if (!tab) throw new Error(`нет сессии ${String(sessionId)}: вкладки нет`);
      await ctx.documents.reveal(tab.doc);
    },
    async create(request: SessionCreateRequest) {
      const parsed = validateCreateInput(request);
      if (typeof parsed === 'string') throw new Error(parsed);
      const labels = (request as { labels?: unknown }).labels;
      let patch;
      if (labels !== undefined) {
        patch = validateLabelsPatch(labels);
        if (typeof patch === 'string') throw new Error(`labels: ${patch}`);
      }
      const { sessionId, title } = await launcher.open(parsed, patch ? { labels: patch } : {});
      return { sessionId, title };
    },
    send: (sessionId, text) => input.send(sessionId, text),
    paste: (sessionId, text, options) => input.paste(sessionId, text, options?.submit === true),
    labels: (sessionId) => Promise.resolve(registry.labels(idOf(sessionId))),
    setLabels(sessionId, patch) {
      const parsed = validateLabelsPatch(patch);
      if (typeof parsed === 'string') return Promise.reject(new Error(parsed));
      return Promise.resolve(registry.setLabels(idOf(sessionId), parsed));
    },
    find: (kind, key) => Promise.resolve(typeof key === 'string' ? registry.find(kindOf(kind), key) : null),
    uses: (root) => Promise.resolve(typeof root === 'string' && registry.uses(root)),
  };
}
