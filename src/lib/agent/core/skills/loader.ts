import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, validateSkillFrontmatter, type SkillFrontmatter } from './frontmatter';
import { defineTool, type Logger, type Tool } from '../types/tools';

export interface Skill {
  name: string;
  description: string;
  dir: string;
  dirName: string;
  filePath: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string[];
  metadata?: Record<string, string>;
  source: string;
  /** Populated lazily on first load. */
  body?: string;
}

export interface SkillIssue {
  dir: string;
  level: 'error' | 'warning';
  message: string;
}

export interface SkillLoaderOptions {
  dirs: string[];
  compat?: boolean;
  homeDir?: string;
  workspaceRoot: string;
  logger?: Logger;
}

const COMPAT_DIRS = ['.claude/skills', '.agents/skills', '.qoder/skills', '.codex/skills'];

export function defaultSkillDirs(workspaceRoot: string, homeDir: string): string[] {
  return [path.join(workspaceRoot, '.nosie', 'skills'), path.join(homeDir, '.nosie', 'skills')];
}

export class SkillRegistry {
  private skills = new Map<string, Skill>();
  private issues: SkillIssue[] = [];

  addIssue(issue: SkillIssue): void {
    this.issues.push(issue);
  }

  get all(): Skill[] {
    return [...this.skills.values()];
  }

  get count(): number {
    return this.skills.size;
  }

  get errors(): SkillIssue[] {
    return this.issues;
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  add(skill: Skill): void {
    this.skills.set(skill.name, skill);
  }

  /**
   * Renders the progressive-disclosure layer 1: name + description only, so the
   * body never reaches the model until it explicitly asks for the skill.
   */
  renderCatalog(): string {
    if (!this.skills.size) return '';
    const rows = this.all
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => `  <skill>\n    <name>${escapeXml(s.name)}</name>\n    <description>${escapeXml(s.description)}</description>\n    <location>${escapeXml(s.filePath)}</location>\n  </skill>`);
    return [
      '<available_skills>',
      ...rows,
      '</available_skills>',
      '',
      `A skill is a packaged set of instructions for a specific kind of task. When the current task matches a skill's description, call the \`skill\` tool with its exact name to load the full instructions before acting. Skills may reference bundled files under their directory; read those on demand.`,
    ].join('\n');
  }

  /** Tools a skill pre-authorizes while it is active. */
  allowedToolsFor(names: string[]): Array<{ tool: string; argPattern?: string }> {
    const rules: Array<{ tool: string; argPattern?: string }> = [];
    for (const name of names) {
      const skill = this.skills.get(name);
      for (const entry of skill?.allowedTools ?? []) {
        const m = /^([a-zA-Z0-9_*-]+)\((.*)\)$/.exec(entry);
        if (m) rules.push({ tool: m[1]!, argPattern: m[2] });
        else rules.push({ tool: entry });
      }
    }
    return rules;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

export async function loadSkills(opts: SkillLoaderOptions): Promise<SkillRegistry> {
  const registry = new SkillRegistry();
  const dirs = [...opts.dirs];
  if (opts.compat !== false) {
    for (const rel of COMPAT_DIRS) {
      dirs.push(path.join(opts.workspaceRoot, rel));
      if (opts.homeDir) dirs.push(path.join(opts.homeDir, rel));
    }
  }

  for (const root of dirs) {
    if (!(await isDirectory(root))) continue;
    const source = path.basename(path.dirname(root)) === '.nosie' ? path.basename(root) : root;
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (err) {
      registry.addIssue({ dir: root, level: 'warning', message: `cannot read skill directory: ${(err as Error).message}` });
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const dir = path.join(root, entry.name);
      const filePath = path.join(dir, 'SKILL.md');
      let raw: string;
      try {
        raw = await fs.readFile(filePath, 'utf8');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') registry.addIssue({ dir, level: 'warning', message: `cannot read SKILL.md: ${(err as Error).message}` });
        continue;
      }
      const { data, body, error } = parseFrontmatter(raw);
      if (error) {
        registry.addIssue({ dir, level: 'error', message: `SKILL.md frontmatter: ${error}` });
        continue;
      }
      const validation = validateSkillFrontmatter(data, entry.name);
      if (!validation.ok) {
        for (const e of validation.errors) registry.addIssue({ dir, level: 'error', message: e });
        continue;
      }
      for (const w of validation.warnings) registry.addIssue({ dir, level: 'warning', message: w });
      const parsed: SkillFrontmatter = validation.parsed;
      const skill: Skill = {
        name: parsed.name!,
        description: parsed.description!,
        dir,
        dirName: entry.name,
        filePath,
        license: parsed.license,
        compatibility: parsed.compatibility,
        allowedTools: parsed.allowedTools,
        metadata: parsed.metadata,
        source,
        body: body.trim(),
      };
      if (registry.get(skill.name)) {
        registry.addIssue({ dir, level: 'warning', message: `skill "${skill.name}" is overridden by ${filePath}` });
      }
      registry.add(skill);
    }
  }
  opts.logger?.debug(`loaded ${registry.count} skills`);
  return registry;
}

export function createSkillTool(registry: SkillRegistry): Tool {
  return defineTool<{ name: string }>({
    name: 'skill',
    description: 'Load the full instructions of a skill by its exact name. Call this before following a skill; the listing in the system prompt only carries name and description.',
    kind: 'read',
    readOnly: true,
    primaryArg: 'name',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact skill name from <available_skills>.' },
      },
      required: ['name'],
    },
    title: (a) => `Load skill ${a.name}`,
    async execute(args) {
      const skill = registry.get(args.name);
      if (!skill) {
        const available = registry.all.map((s) => s.name).join(', ') || 'none';
        return {
          content: [{ type: 'text', text: `Unknown skill "${args.name}". Available: ${available}` }],
          isError: true,
        };
      }
      let body = skill.body;
      if (body === undefined) {
        const { body: parsed } = parseFrontmatter(await fs.readFile(skill.filePath, 'utf8'));
        body = parsed.trim();
        skill.body = body;
      }
      const notes = [
        `<skill name="${skill.name}">`,
        `Base directory: ${skill.dir}`,
        `Bundled resources (scripts/, references/, assets/) are relative to this directory; read or run them from there.`,
        '',
        body,
        '</skill>',
      ];
      return { content: [{ type: 'text', text: notes.join('\n') }], meta: { skill: skill.name, allowedTools: skill.allowedTools } };
    },
  });
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}
