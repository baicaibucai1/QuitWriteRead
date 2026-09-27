import type { ContentBlock } from './messages';
import type { ToolKind } from './permission';

export interface JSONSchema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null' | string[];
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema | JSONSchema[];
  enum?: unknown[];
  default?: unknown;
  additionalProperties?: boolean | JSONSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  anyOf?: JSONSchema[];
  oneOf?: JSONSchema[];
  allOf?: JSONSchema[];
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface Sandbox {
  readonly root: string;
  readonly additionalRoots: readonly string[];
  resolve(inputPath: string): Promise<string>;
  resolveSync(inputPath: string): string;
  isInside(absolutePath: string): boolean;
}

export interface ToolContext {
  signal: AbortSignal;
  workspaceRoot: string;
  sessionId: string;
  runId: string;
  toolCallId: string;
  sandbox: Sandbox;
  logger: Logger;
  progress(text: string): void;
  services: ToolServices;
}

export interface ToolServices {
  memory?: import('../memory/store').MemoryStores;
  skills?: import('../skills/loader').SkillRegistry;
  emit?: (event: import('./events').AgentEvent) => void;
}

export interface DisplayHint {
  kind?: 'diff' | 'terminal' | 'text' | 'json';
  path?: string;
  oldText?: string;
  newText?: string;
  locations?: Array<{ path: string; line?: number }>;
}

export interface ToolResult {
  content: ContentBlock[] | string;
  isError?: boolean;
  display?: DisplayHint;
  meta?: Record<string, unknown>;
}

export interface Tool<A extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: JSONSchema;
  kind?: ToolKind;
  readOnly?: boolean;
  needsApproval?: boolean | ((args: A, ctx: ToolContext) => boolean | Promise<boolean>);
  execute(args: A, ctx: ToolContext): Promise<ToolResult>;
  title?: (args: A) => string;
  primaryArg?: keyof A & string;
  concurrency?: 'parallel' | 'sequential';
  source?: 'builtin' | 'host' | 'mcp' | 'skill';
}

/**
 * Hosts author tools with a concrete args type for editor help; the kernel
 * stores them uniformly, so the generic is erased at this boundary.
 */
export function defineTool<A extends Record<string, unknown>>(tool: Tool<A>): Tool {
  return tool as unknown as Tool;
}

export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
