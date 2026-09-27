export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  onChunk?: () => void,
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let current: { event?: string; data: string[]; id?: string; retry?: number } = { data: [] };

  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      onChunk?.();
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          if (current.data.length || current.event || current.id) {
            yield { event: current.event, data: current.data.join('\n'), id: current.id, retry: current.retry };
          }
          current = { data: [] };
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        switch (field) {
          case 'data':
            current.data.push(value);
            break;
          case 'event':
            current.event = value;
            break;
          case 'id':
            current.id = value;
            break;
          case 'retry': {
            const n = Number(value);
            if (Number.isFinite(n)) current.retry = n;
            break;
          }
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const line = buffer.replace(/\r$/, '');
      if (line.startsWith('data:')) current.data.push(line.slice(5).replace(/^ /, ''));
    }
    if (current.data.length) yield { event: current.event, data: current.data.join('\n'), id: current.id };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

export function formatSse(ev: SseEvent): string {
  let out = '';
  if (ev.id !== undefined) out += `id: ${ev.id}\n`;
  if (ev.event) out += `event: ${ev.event}\n`;
  for (const line of ev.data.split('\n')) out += `data: ${line}\n`;
  return out + '\n';
}
