import type { LlmMessage, LlmToolCall } from '../types/provider';
import type { Message, UserMessage } from '../types/messages';

export interface ConvertOptions {
  echoReasoning?: boolean;
  /**
   * Whether the endpoint takes pixels. False keeps the `[image …]` placeholder
   * (a text-only model 400s on a content array with `image_url`), and the loop
   * is expected to say so in a warning — silently swallowing the attachment is
   * what this function used to do even when the model *could* see it.
   */
  imageInput?: boolean;
}

type UserPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

function userContent(msg: UserMessage, imageInput: boolean): string | UserPart[] {
  const images = msg.content.filter((b) => b.type === 'image');
  if (!images.length) {
    return msg.content
      .map((b) => (b.type === 'text' ? b.text : b.type === 'resource' ? (b.text ?? `[resource ${b.uri}]`) : ''))
      .filter(Boolean)
      .join('\n');
  }
  return msg.content.map((b) => {
    if (b.type === 'image') {
      if (!imageInput) return { type: 'text' as const, text: `[image ${b.mimeType}, not sent: this model takes no images]` };
      // A data URL is the portable form: every OpenAI-compatible server that
      // advertises image input takes it, and it needs no public object storage.
      return { type: 'image_url' as const, image_url: { url: `data:${b.mimeType};base64,${b.data}`, detail: 'auto' as const } };
    }
    if (b.type === 'resource') return { type: 'text' as const, text: b.text ?? `[resource ${b.uri}]` };
    return { type: 'text' as const, text: b.text };
  });
}

/**
 * Internal session messages -> OpenAI wire messages.
 * Tool results must immediately follow the assistant message that requested them,
 * so a single assistant message with N tool calls expands to assistant + N tool rows.
 */
export function toLlmMessages(messages: Message[], opts: ConvertOptions = {}): LlmMessage[] {
  const imageInput = opts.imageInput !== false;
  const out: LlmMessage[] = [];
  for (const m of messages) {
    switch (m.role) {
      case 'system':
        out.push({ role: 'system', content: m.content });
        break;
      case 'user':
        out.push({ role: 'user', content: userContent(m, imageInput) });
        break;
      case 'assistant': {
        const text = m.parts
          .filter((p) => p.type === 'text')
          .map((p) => (p.type === 'text' ? p.text : ''))
          .join('');
        const reasoning = m.parts
          .filter((p) => p.type === 'reasoning')
          .map((p) => (p.type === 'reasoning' ? p.text : ''))
          .join('\n');
        // Denied and cancelled calls stay in history on purpose: the model has
        // to see the refusal result, and `repairToolPairing` drops the calls
        // that never got a result at all.
        const calls: LlmToolCall[] = m.parts
          .filter((p) => p.type === 'tool_call')
          .map((p) =>
            p.type === 'tool_call'
              ? { id: p.id, type: 'function' as const, function: { name: p.name, arguments: safeArgs(p) } }
              : ({} as LlmToolCall),
          );
        const row: LlmMessage = {
          role: 'assistant',
          content: text || (calls.length ? null : ''),
          ...(calls.length ? { tool_calls: calls } : {}),
        };
        if (reasoning) {
          if (opts.echoReasoning) (row as Record<string, unknown>).reasoning_content = reasoning;
        }
        out.push(row);
        break;
      }
      case 'tool': {
        const images = m.content.filter((b) => b.type === 'image');
        const text = m.cleared
          ? '[Old tool result content cleared]'
          : m.content
              .map((b) => (b.type === 'text' ? b.text : b.type === 'resource' ? (b.text ?? `[resource ${b.uri}]`) : `[image ${b.mimeType}]`))
              .join('\n');
        out.push({ role: 'tool', tool_call_id: m.toolCallId, content: text || (m.isError ? 'error' : '') });
        // `role: 'tool'` carries a string on every OpenAI-compatible server, so a
        // picture a tool fetched cannot ride in the row that answers the call.
        // It follows as a user turn instead — same information, legal shape.
        if (images.length && imageInput && !m.cleared) {
          out.push({
            role: 'user',
            content: [
              { type: 'text', text: `[image attached by the ${m.toolName} result above]` },
              ...images.map((b) => (b.type === 'image' ? { type: 'image_url' as const, image_url: { url: `data:${b.mimeType};base64,${b.data}`, detail: 'auto' as const } } : { type: 'text' as const, text: '' })),
            ],
          });
        }
        break;
      }
    }
  }
  return repairToolPairing(out);
}

/** A truncated or malformed stream of arguments would 400 the next request. */
function safeArgs(part: { rawArgs?: string; args?: unknown }): string {
  if (!part.rawArgs) return JSON.stringify(part.args ?? {});
  try {
    JSON.parse(part.rawArgs);
    return part.rawArgs;
  } catch {
    return JSON.stringify(part.args ?? {});
  }
}

/**
 * Compaction can drop one side of a tool_call / tool_result pair, which most
 * providers reject with a 400. Drop orphan results and stub orphan calls.
 */
export function repairToolPairing(messages: LlmMessage[]): LlmMessage[] {
  const answered = new Set<string>();
  for (const m of messages) if (m.role === 'tool') answered.add(m.tool_call_id);
  const declared = new Set<string>();
  for (const m of messages) if (m.role === 'assistant' && m.tool_calls) for (const c of m.tool_calls) declared.add(c.id);

  const out: LlmMessage[] = [];
  for (const m of messages) {
    if (m.role === 'tool' && !declared.has(m.tool_call_id)) continue;
    if (m.role === 'assistant' && m.tool_calls) {
      const kept = m.tool_calls.filter((c) => answered.has(c.id));
      if (kept.length !== m.tool_calls.length) {
        const patched = { ...m, tool_calls: kept } as LlmMessage;
        if (kept.length === 0) delete (patched as Record<string, unknown>).tool_calls;
        out.push(patched);
        continue;
      }
    }
    out.push(m);
  }
  return out;
}

export function messagesToText(messages: Message[]): string {
  return messages
    .map((m) => {
      if (m.role === 'assistant') return m.parts.map((p) => (p.type === 'text' ? p.text : p.type === 'reasoning' ? `<thinking>\n${p.text}\n</thinking>` : `[tool_call ${p.name}]`)).join('');
      if (m.role === 'tool') return `[${m.toolName} result] ${m.content.map((b) => (b.type === 'text' ? b.text : '')).join('')}`;
      if (m.role === 'user') return m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      return '';
    })
    .join('\n\n');
}
