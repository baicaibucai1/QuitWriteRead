import type { Tool, ToolContext, JSONSchema } from '../types/tools';
import { TOOL_NAME_PATTERN } from '../types/tools';
import type { LlmToolDef } from '../types/provider';
import { ConfigError, InvalidToolArgsError, ToolNotFoundError } from '../types/errors';

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): () => void {
    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      throw new ConfigError(`Invalid tool name "${tool.name}": must match ${TOOL_NAME_PATTERN}`);
    }
    if (!tool.description) throw new ConfigError(`Tool "${tool.name}" must have a description`);
    this.tools.set(tool.name, tool);
    return () => this.unregister(tool.name);
  }

  registerAll(tools: Tool[]): void {
    for (const t of tools) this.register(t);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  clear(): void {
    this.tools.clear();
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  toLlmTools(): LlmToolDef[] {
    return this.list().map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: (t.parameters ?? { type: 'object' }) as JSONSchema },
    }));
  }
}

type Primitive = string | number | boolean | null;

function typeOf(value: unknown): 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null' | 'undefined' {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (t === 'string' || t === 'boolean' || t === 'object' || t === 'undefined') return t;
  return 'object';
}

function matchesType(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'integer') return actual === 'integer';
  return actual === expected;
}

/**
 * Deliberately shallow: models produce junk we must not forward to host code,
 * but a full JSON Schema validator is not worth the dependency.
 */
export function validateArgs(schema: JSONSchema | undefined, args: Record<string, unknown>, toolName: string): string[] {
  const errors: string[] = [];
  if (!schema || schema.type !== 'object') return errors;
  const props = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) errors.push(`missing required property "${key}"`);
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = props[key];
    if (!prop) {
      if (schema.additionalProperties === false) errors.push(`unknown property "${key}"`);
      continue;
    }
    if (typeof prop.type === 'string' && value !== undefined && !matchesType(value, prop.type)) {
      errors.push(`property "${key}" expected ${prop.type}, got ${typeOf(value)}`);
      continue;
    }
    if (prop.enum && value !== undefined && !prop.enum.some((e) => e === value)) {
      errors.push(`property "${key}" must be one of ${prop.enum.map((e) => JSON.stringify(e)).join(', ')}`);
    }
    if (prop.type === 'string' && typeof value === 'string') {
      if (prop.minLength !== undefined && value.length < prop.minLength) errors.push(`property "${key}" shorter than minLength ${prop.minLength}`);
      if (prop.maxLength !== undefined && value.length > prop.maxLength) errors.push(`property "${key}" longer than maxLength ${prop.maxLength}`);
      if (prop.pattern && !new RegExp(prop.pattern).test(value)) errors.push(`property "${key}" does not match pattern ${prop.pattern}`);
    }
    if (prop.type === 'number' || prop.type === 'integer') {
      const n = value as Primitive | undefined;
      if (typeof n === 'number') {
        if (prop.minimum !== undefined && n < prop.minimum) errors.push(`property "${key}" < minimum ${prop.minimum}`);
        if (prop.maximum !== undefined && n > prop.maximum) errors.push(`property "${key}" > maximum ${prop.maximum}`);
      }
    }
    if (prop.type === 'array' && Array.isArray(value) && prop.items && !Array.isArray(prop.items) && typeof prop.items.type === 'string') {
      const itemType = prop.items.type;
      value.forEach((v, i) => {
        if (!matchesType(v, itemType)) errors.push(`item ${i} of "${key}" expected ${itemType}, got ${typeOf(v)}`);
      });
    }
  }
  if (errors.length) throw new InvalidToolArgsError(toolName, errors.join('; '));
  return errors;
}

export function parseToolArgs(raw: string | undefined, toolName: string): Record<string, unknown> {
  const text = (raw ?? '').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    throw new Error(`arguments must be a JSON object, got ${typeOf(parsed)}`);
  } catch (err) {
    throw new InvalidToolArgsError(toolName, (err as Error).message, { rawArgs: text.slice(0, 2000) });
  }
}

export function makeToolContext(partial: Omit<ToolContext, 'progress'> & { onProgress?: (t: string) => void }): ToolContext {
  return { ...partial, progress: partial.onProgress ?? (() => {}) };
}

export { ToolNotFoundError };
