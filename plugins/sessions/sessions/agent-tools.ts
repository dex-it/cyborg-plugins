import type { AgentTool, AgentToolSpec, SessionAction } from '@cyborg-harness/contracts';

// Инструменты поставщиков `cyborg.agent-tool` (кратность many) на том же сервере MCP, что и инструменты сессий. Перенос из пилота ядра
// (playground/plugins/sessions/mcp.ts). Описание инструмента попадает в контекст агента до вызова, поэтому контракт отдают только плагины поставки (правило ядра).

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_ACTIONS = 6;
export const MAX_LABEL = 40;
const MAX_TEXT = 2000;

export interface ToolSource {
  readonly pluginId: string;
  readonly impl: AgentTool;
}

export interface CollectedTool {
  readonly spec: AgentToolSpec;
  readonly source: ToolSource;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Инструменты всех поставщиков по порядку id плагина; чужое имя, повтор и имя из `reserved` (свои инструменты сессий) отброшены с записью в журнал. */
export async function collectTools(sources: readonly ToolSource[], reserved: readonly string[], log: (message: string) => void): Promise<Map<string, CollectedTool>> {
  const out = new Map<string, CollectedTool>();
  for (const source of sources.toSorted((a, b) => (a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0))) {
    let specs: readonly AgentToolSpec[];
    try {
      specs = await source.impl.tools();
    } catch (error) {
      log(`${source.pluginId}: список инструментов - ${String(error)}`);
      continue;
    }
    for (const spec of specs) {
      if (!TOOL_NAME.test(spec.name) || !isRecord(spec.inputSchema) || spec.inputSchema.type !== 'object') log(`${source.pluginId}: инструмент ${spec.name} отброшен - имя [A-Za-z0-9_-] и inputSchema с type object`);
      else if (reserved.includes(spec.name)) log(`${source.pluginId}: инструмент ${spec.name} отброшен - имя занято инструментом сессий`);
      else if (out.has(spec.name)) log(`${source.pluginId}: инструмент ${spec.name} уже есть у ${out.get(spec.name)?.source.pluginId ?? ''}`);
      else out.set(spec.name, { spec, source });
    }
  }
  return out;
}

/** Кнопки идут в терминал по клику человека: управляющие символы срезаны, подпись и текст ограничены. */
export function readActions(raw: unknown): SessionAction[] {
  if (!Array.isArray(raw)) return [];
  const clean = (s: string) => s.replace(/\p{Cc}/gu, ' ').trim();
  return raw.slice(0, MAX_ACTIONS).flatMap((a: unknown) => {
    if (!isRecord(a) || typeof a.label !== 'string' || typeof a.text !== 'string') return [];
    const label = clean(a.label).slice(0, MAX_LABEL);
    const text = clean(a.text).slice(0, MAX_TEXT);
    return label && text ? [{ label, text, ...(a.submit === true && { submit: true }) }] : [];
  });
}
