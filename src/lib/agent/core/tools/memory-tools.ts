import type { Tool } from '../types/tools';
import { defineTool } from '../types/tools';
import { MEMORY_TYPES, type MemoryType, type MemoryStores } from '../memory/store';

export function createMemoryTools(stores: MemoryStores): Tool[] {
  const memorySave = defineTool<{ name: string; description: string; type: string; content: string; scope?: 'user' | 'project' }>({
    name: 'memory_save',
    description:
      'Persist a memory entry to the index plus its own file so future conversations can recall it. Use for the user profile, guidance they gave you, project context with motivation, or pointers to external resources. Do not store code patterns, file paths or anything derivable from the repo.',
    kind: 'edit',
    primaryArg: 'name',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short kebab-case slug for this memory.' },
        description: { type: 'string', description: 'One-line summary used to decide relevance later. Be specific.' },
        type: { type: 'string', enum: MEMORY_TYPES, description: 'user = who they are; feedback = guidance on how to work; project = ongoing work context; reference = where to look externally.' },
        content: { type: 'string', description: 'The memory itself. For feedback/project types include **Why:** and **How to apply:** lines.' },
        scope: { type: 'string', enum: ['user', 'project'], description: 'user = true across all this user projects; project = only this one. Defaults by type: user/feedback -> user, project/reference -> project.' },
      },
      required: ['name', 'description', 'type', 'content'],
    },
    title: (a) => `Save memory: ${a.name}`,
    async execute(args, ctx) {
      const type = (MEMORY_TYPES as string[]).includes(args.type) ? (args.type as MemoryType) : null;
      if (!type) return { content: [{ type: 'text', text: `Invalid type "${args.type}". Must be one of: ${MEMORY_TYPES.join(', ')}` }], isError: true };
      const scope = args.scope ?? (type === 'user' || type === 'feedback' ? 'user' : 'project');
      const store = stores.for(scope) ?? stores.all()[0];
      if (!store) return { content: [{ type: 'text', text: 'Memory is disabled for this agent.' }], isError: true };
      const { created } = await store.save({ name: args.name, description: args.description, type, content: args.content, scope });
      ctx.services.emit?.({ type: 'memory_update', op: 'save', name: args.name, scope });
      return { content: [{ type: 'text', text: `${created ? 'Saved' : 'Updated'} ${scope} memory "${args.name}" at ${store.dir}` }] };
    },
  });

  const memorySearch = defineTool<{ query: string; types?: string[]; limit?: number }>({
    name: 'memory_search',
    description: 'Search saved memories by keywords across both user and project stores. Call this before assuming something about the user or before acting on remembered facts.',
    kind: 'search',
    readOnly: true,
    primaryArg: 'query',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords or a short question.' },
        types: { type: 'array', items: { type: 'string', enum: MEMORY_TYPES }, description: 'Restrict to these memory types.' },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['query'],
    },
    title: (a) => `Search memory: ${a.query}`,
    async execute(args) {
      const storesList = stores.all();
      if (!storesList.length) return { content: [{ type: 'text', text: 'Memory is disabled for this agent.' }], isError: true };
      const results = (
        await Promise.all(
          storesList.map((s) => s.search({ query: args.query, types: args.types as MemoryType[] | undefined, limit: args.limit ?? 5 })),
        )
      )
        .flat()
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .slice(0, args.limit ?? 5);
      if (!results.length) return { content: [{ type: 'text', text: `No memories matched "${args.query}".` }] };
      const text = results
        .map((r) => `### ${r.name} (${r.scope}/${r.type})\n${r.description}\n\n${r.content}\n_source: ${r.path}_`)
        .join('\n\n---\n\n');
      return { content: [{ type: 'text', text }] };
    },
  });

  const memoryForget = defineTool<{ name: string; scope?: 'user' | 'project' }>({
    name: 'memory_forget',
    description: 'Delete a memory entry by name. Use when the user asks to forget something or when a memory is proven wrong by current evidence.',
    kind: 'delete',
    primaryArg: 'name',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        scope: { type: 'string', enum: ['user', 'project'], description: 'Omit to search both stores.' },
      },
      required: ['name'],
    },
    title: (a) => `Forget memory: ${a.name}`,
    async execute(args, ctx) {
      const targets = args.scope ? [stores.for(args.scope)].filter(Boolean) : stores.all();
      let removed = false;
      for (const store of targets) {
        if (await store!.forget(args.name)) {
          removed = true;
          ctx.services.emit?.({ type: 'memory_update', op: 'forget', name: args.name, scope: store!.scope });
        }
      }
      return removed
        ? { content: [{ type: 'text', text: `Removed memory "${args.name}".` }] }
        : { content: [{ type: 'text', text: `No memory named "${args.name}" was found.` }], isError: true };
    },
  });

  return [memorySave, memorySearch, memoryForget];
}
