import type { PermissionConfig, PermissionDecision, PermissionMode, PermissionRule, PermissionResponse } from '../types/permission';
import { PERMISSION_OPTIONS } from '../types/permission';
import type { Tool, ToolContext } from '../types/tools';
import type { PermissionRequest } from '../types/events';
import { newId } from '../utils';
import { matchGlob } from '../utils';
import { ConfigError } from '../types/errors';

export interface PermissionSubject {
  tool: Tool;
  args: Record<string, unknown>;
  toolCallId: string;
  title: string;
}

interface NormalizedRule {
  tool: string;
  argPattern?: string;
}

function normalizeRules(rules: Array<string | PermissionRule> | undefined): NormalizedRule[] {
  return (rules ?? []).map((r) => {
    if (typeof r === 'string') {
      const m = /^([a-zA-Z0-9_*-]+)\((.*)\)$/.exec(r.trim());
      if (m) return { tool: m[1]!, argPattern: m[2] };
      return { tool: r.trim() };
    }
    return r;
  });
}

function primaryValue(tool: Tool, args: Record<string, unknown>): string | undefined {
  const key = (tool as { primaryArg?: string }).primaryArg;
  if (key && args[key] !== undefined) return String(args[key]);
  for (const candidate of ['command', 'path', 'file_path', 'filePath', 'pattern', 'query', 'url']) {
    if (typeof args[candidate] === 'string') return args[candidate] as string;
  }
  const first = Object.values(args)[0];
  return typeof first === 'string' ? first : undefined;
}

function ruleMatches(rule: NormalizedRule, tool: Tool, args: Record<string, unknown>): boolean {
  if (!matchGlob(rule.tool, tool.name)) return false;
  if (!rule.argPattern) return true;
  const value = primaryValue(tool, args);
  if (value === undefined) return false;
  return matchGlob(rule.argPattern, value, { matchBase: true });
}

const EDIT_KINDS = new Set(['edit', 'move']);

export class PermissionEngine {
  private mode: PermissionMode;
  private allow: NormalizedRule[];
  private deny: NormalizedRule[];
  private ask: NormalizedRule[];
  private sessionRules: { allow: NormalizedRule[]; deny: NormalizedRule[] } = { allow: [], deny: [] };
  private onRequest?: PermissionConfig['onRequest'];
  private dangerouslyAllowAll: boolean;

  constructor(config: PermissionConfig = {}) {
    this.mode = config.mode ?? 'default';
    this.allow = normalizeRules(config.allow);
    this.deny = normalizeRules(config.deny);
    this.ask = normalizeRules(config.ask);
    this.onRequest = config.onRequest;
    this.dangerouslyAllowAll = config.dangerouslyAllowAll === true;
    if (this.mode === 'bypassPermissions' && !this.dangerouslyAllowAll) {
      throw new ConfigError('permission.mode="bypassPermissions" requires permission.dangerouslyAllowAll: true');
    }
  }

  get currentMode(): PermissionMode {
    return this.mode;
  }

  setRequestHandler(handler: PermissionConfig['onRequest']): void {
    this.onRequest = handler;
  }

  setMode(mode: PermissionMode): void {
    if (mode === 'bypassPermissions' && !this.dangerouslyAllowAll) {
      throw new ConfigError('Cannot switch to bypassPermissions without dangerouslyAllowAll');
    }
    this.mode = mode;
  }

  addSessionRule(bucket: 'allow' | 'deny', rule: NormalizedRule): void {
    this.sessionRules[bucket].push(rule);
  }

  /** Deny rules outlive an approval: rewritten arguments are re-checked. */
  checkDeny(tool: Tool, args: Record<string, unknown>): string | undefined {
    for (const rule of [...this.deny, ...this.sessionRules.deny]) {
      if (ruleMatches(rule, tool, args)) return `Blocked by deny rule for ${tool.name}`;
    }
    return undefined;
  }

  private modeAllows(subject: PermissionSubject): boolean {
    const { tool } = subject;
    switch (this.mode) {
      case 'bypassPermissions':
        return true;
      case 'readOnly':
        return tool.readOnly === true;
      case 'acceptEdits':
        return tool.readOnly === true || (tool.kind !== undefined && EDIT_KINDS.has(tool.kind));
      case 'default':
      default:
        return tool.readOnly === true;
    }
  }

  /**
   * Fixed precedence: hook decision -> deny -> ask -> mode -> allow -> tool self-declaration -> escalate.
   * Kept intentionally rigid; a host must be able to reason about why a call was blocked.
   */
  async evaluate(subject: PermissionSubject, hookDecision?: PermissionDecision): Promise<PermissionDecision> {
    const { tool, args } = subject;
    if (hookDecision) return hookDecision;

    if (this.deny.some((r) => ruleMatches(r, tool, args))) return { behavior: 'deny', message: `Blocked by deny rule for ${tool.name}` };
    if (this.sessionRules.deny.some((r) => ruleMatches(r, tool, args))) return { behavior: 'deny', message: `Blocked by previous rejection of ${tool.name}` };
    if (this.ask.some((r) => ruleMatches(r, tool, args))) return { behavior: 'ask', reason: `ask rule matched ${tool.name}` };

    if (this.modeAllows(subject)) return { behavior: 'allow' };

    if (this.allow.some((r) => ruleMatches(r, tool, args)) || this.sessionRules.allow.some((r) => ruleMatches(r, tool, args))) {
      return { behavior: 'allow' };
    }

    const declared = tool.needsApproval;
    if (typeof declared === 'function') {
      const ctx = (subject as { ctx?: ToolContext }).ctx;
      if (await declared(args, ctx as ToolContext)) return { behavior: 'ask', reason: `${tool.name} requested approval` };
      // The tool vouches for this call; a read-only freeze outranks even that.
      if (this.mode !== 'readOnly') return { behavior: 'allow' };
    } else if (declared === true) {
      return { behavior: 'ask', reason: `${tool.name} requires approval` };
    } else if (declared === false && this.mode !== 'readOnly') {
      return { behavior: 'allow' };
    }

    return { behavior: 'ask', reason: `No rule allows ${tool.name} in ${this.mode} mode` };
  }

  buildRequest(sessionId: string, subject: PermissionSubject, reason?: string): PermissionRequest {
    return {
      requestId: newId('perm'),
      sessionId,
      toolCallId: subject.toolCallId,
      name: subject.tool.name,
      args: subject.args,
      kind: subject.tool.kind ?? (subject.tool.readOnly ? 'read' : 'other'),
      title: subject.title,
      options: PERMISSION_OPTIONS,
      reason,
    };
  }

  async requestUserDecision(request: PermissionRequest, signal: AbortSignal): Promise<PermissionResponse> {
    if (!this.onRequest) {
      return { optionId: 'cancelled', message: 'No permission handler configured; denying by default' };
    }
    return this.onRequest(request, signal);
  }
}

export function applyResponseToRules(engine: PermissionEngine, request: PermissionRequest, response: PermissionResponse): void {
  const rule = { tool: request.name };
  switch (response.optionId) {
    case 'allow_always':
      engine.addSessionRule('allow', rule);
      break;
    case 'reject_always':
      engine.addSessionRule('deny', rule);
      break;
    default:
      break;
  }
}

export { normalizeRules, type NormalizedRule };
