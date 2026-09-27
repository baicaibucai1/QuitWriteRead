export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export const MEMORY_TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference'];

export interface MemoryEntry {
  name: string;
  description: string;
  type: MemoryType;
  content: string;
  path?: string;
  updatedAt?: number;
  scope: 'user' | 'project';
}

export interface MemoryIndexEntry {
  name: string;
  description: string;
  type: MemoryType;
  path: string;
  updatedAt: number;
}

export interface MemoryQuery {
  query: string;
  types?: MemoryType[];
  limit?: number;
}

export interface MemoryStore {
  readonly scope: 'user' | 'project';
  readonly dir: string;
  list(): Promise<MemoryIndexEntry[]>;
  get(name: string): Promise<MemoryEntry | null>;
  save(entry: MemoryEntry): Promise<{ created: boolean }>;
  forget(name: string): Promise<boolean>;
  search(q: MemoryQuery): Promise<MemoryEntry[]>;
  renderIndex(): Promise<string>;
}

export interface MemoryStores {
  user?: MemoryStore;
  project?: MemoryStore;
  all(): MemoryStore[];
  for(scope: 'user' | 'project'): MemoryStore | undefined;
}

export function createMemoryStores(map: { user?: MemoryStore; project?: MemoryStore }): MemoryStores {
  return {
    user: map.user,
    project: map.project,
    all() {
      return [map.user, map.project].filter(Boolean) as MemoryStore[];
    },
    for(scope) {
      return map[scope];
    },
  };
}

export const MEMORY_TOOL_GUIDANCE = `## Memory

You have persistent file-based memory that survives conversations. Two stores exist:
- **user** (applies to everything this user does): role, preferences, communication style, demonstrated expertise.
- **project** (only this codebase): goals, decisions, deadlines, constraints, and why behind them.

Memory types: \`user\` (who they are), \`feedback\` (guidance they gave you — corrections AND confirmations), \`project\` (ongoing work and context), \`reference\` (where to find things in external systems).

Save when: the user states a preference or role, corrects your approach, confirms a non-obvious choice, or shares a deadline or decision with motivation. Convert relative dates to absolute ones.

Structure feedback and project entries as the rule/fact, then **Why:** and **How to apply:** lines, so future-you can judge edge cases.

Do NOT save: code patterns, architecture, file paths, project structure, git history, debugging fixes, or anything in AGENTS.md/README — those are derivable from the repo. Exclusions apply even if asked; ask what was surprising or non-obvious, and save only that.

When the user says to remember something, save it immediately. When they say to forget something, find and remove the entry. Memories go stale: verify against current files before acting on one, and update or delete it rather than acting on outdated information.`;
