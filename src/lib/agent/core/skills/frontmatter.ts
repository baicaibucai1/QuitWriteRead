export interface SkillFrontmatter {
  name?: string;
  description?: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string[];
  metadata?: Record<string, string>;
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Minimal YAML subset parser for SKILL.md frontmatter: scalars, quoted
 * strings, and one level of `key:` / `- item` block lists. Anything richer
 * belongs in the markdown body, not in frontmatter.
 */
export function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string; error?: string } {
  const normalized = raw.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---')) return { data: {}, body: normalized, error: 'missing opening --- frontmatter delimiter' };
  const firstLineEnd = normalized.indexOf('\n');
  if (firstLineEnd === -1) return { data: {}, body: normalized, error: 'malformed frontmatter' };
  const closeIdx = findClosingDelimiter(normalized, firstLineEnd + 1);
  if (closeIdx === -1) return { data: {}, body: normalized, error: 'missing closing --- frontmatter delimiter' };

  const yaml = normalized.slice(firstLineEnd + 1, closeIdx);
  const body = normalized.slice(normalized.indexOf('\n', closeIdx) + 1);
  const { data, error } = parseYamlSubset(yaml);
  return { data, body, error };
}

function findClosingDelimiter(text: string, from: number): number {
  let idx = from;
  while (idx < text.length) {
    const lineEnd = text.indexOf('\n', idx);
    const line = lineEnd === -1 ? text.slice(idx) : text.slice(idx, lineEnd);
    if (line.trim() === '---' || line.trim() === '...') return idx;
    if (lineEnd === -1) break;
    idx = lineEnd + 1;
  }
  return -1;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return first === '"' ? JSON.parse(v) : v.slice(1, -1).replace(/''/g, "'");
    }
  }
  return v;
}

interface YamlResult {
  data: Record<string, unknown>;
  error?: string;
}

function parseYamlSubset(yaml: string): YamlResult {
  const data: Record<string, unknown> = {};
  const lines = yaml.split(/\r?\n/);
  let error: string | undefined;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    i++;
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (/^\s/.test(line)) {
      error = `unexpected indentation at: ${line.trim()}`;
      continue;
    }
    const colon = indexOfKeySeparator(line);
    if (colon === -1) {
      error = `cannot parse line: ${line}`;
      continue;
    }
    const key = line.slice(0, colon).trim();
    const inlineValue = line.slice(colon + 1).trim();
    if (inlineValue === '' || inlineValue === '|' || inlineValue === '>' || inlineValue === '|-' || inlineValue === '>-') {
      const isBlockScalar = inlineValue.startsWith('|') || inlineValue.startsWith('>');
      const block: string[] = [];
      const items: string[] = [];
      const nested: Record<string, string> = {};
      while (i < lines.length) {
        const next = lines[i]!;
        if (next.trim() === '') {
          block.push('');
          i++;
          continue;
        }
        if (!/^\s/.test(next)) break;
        const trimmed = next.trim();
        const pair = /^([^:#]+):\s*(.*)$/.exec(trimmed);
        if (!isBlockScalar && pair && pair[1]!.trim() && pair[2] !== undefined) {
          nested[pair[1]!.trim()] = unquote(pair[2]);
        } else if (!isBlockScalar && trimmed.startsWith('- ')) {
          items.push(unquote(trimmed.slice(2)));
        } else {
          block.push(next.replace(/^\s{2}/, ''));
        }
        i++;
      }
      if (!isBlockScalar && items.length) data[key] = items;
      else if (!isBlockScalar && Object.keys(nested).length) data[key] = nested;
      else {
        const text = block.join('\n').replace(/\s+$/, '');
        data[key] = inlineValue.startsWith('>') ? text.replace(/\n/g, ' ') : text;
      }
      continue;
    }
    if (inlineValue.startsWith('[') && inlineValue.endsWith(']')) {
      data[key] = inlineValue
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s))
        .filter(Boolean);
      continue;
    }
    if (inlineValue.startsWith('{') && inlineValue.endsWith('}')) {
      const map: Record<string, string> = {};
      for (const pair of inlineValue.slice(1, -1).split(',')) {
        const [k, ...rest] = pair.split(':');
        if (k !== undefined && rest.length) map[k.trim()] = unquote(rest.join(':'));
      }
      data[key] = map;
      continue;
    }
    data[key] = unquote(inlineValue);
  }
  return { data, error };
}

function indexOfKeySeparator(line: string): number {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < line.length && line[i] !== quote) i++;
      continue;
    }
    if (c === '#' && i > 0 && /\s/.test(line[i - 1]!)) return -1;
    if (c === ':' && (i + 1 >= line.length || /\s/.test(line[i + 1]!))) return i;
  }
  return -1;
}

export interface SkillValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  parsed: SkillFrontmatter;
}

export function validateSkillFrontmatter(data: Record<string, unknown>, dirName: string): SkillValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const name = typeof data.name === 'string' ? data.name.trim() : undefined;
  const description = typeof data.description === 'string' ? data.description.trim() : undefined;

  if (!name) errors.push('frontmatter "name" is required');
  else {
    if (name.length > 64) errors.push(`"name" must be 1-64 characters (got ${name.length})`);
    if (!NAME_RE.test(name)) errors.push(`"name" must be lowercase alphanumeric words separated by single hyphens (got "${name}")`);
    if (name && name !== dirName) errors.push(`"name" (${name}) must match its parent directory name (${dirName})`);
  }
  if (!description) errors.push('frontmatter "description" is required');
  else if (description.length > 1024) errors.push(`"description" must be 1-1024 characters (got ${description.length})`);

  const compatibility = typeof data.compatibility === 'string' ? data.compatibility : undefined;
  if (compatibility && (compatibility.length < 1 || compatibility.length > 500)) warnings.push('"compatibility" should be 1-500 characters');

  const allowedRaw = data['allowed-tools'] ?? data.allowedTools;
  const allowedTools =
    typeof allowedRaw === 'string'
      ? allowedRaw.split(/\s+/).filter(Boolean)
      : Array.isArray(allowedRaw)
        ? allowedRaw.map(String)
        : undefined;

  const metadata =
    data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)
      ? Object.fromEntries(Object.entries(data.metadata as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : undefined;

  if (!description && !errors.some((e) => e.includes('description'))) warnings.push('description should state both what the skill does and when to use it');

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    parsed: {
      name,
      description,
      license: typeof data.license === 'string' ? data.license : undefined,
      compatibility,
      allowedTools,
      metadata,
    },
  };
}
