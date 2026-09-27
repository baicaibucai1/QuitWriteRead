import type { Usage } from '../types/messages';

/**
 * A ceiling for one whole agent tree: the run, plus every subagent it delegates
 * to, plus their delegations. `maxSteps` bounds one loop; it says nothing about a
 * model that fans out into eight parallel `task` calls, each of which is
 * perfectly well-behaved and together costs a fortune. The tree needs its own
 * accountant, and the accountant has to be shared — a per-agent counter is a
 * limit multiplied by the branching factor.
 */
export interface BudgetLimits {
  /** Sum of `usage.totalTokens` across the tree. */
  maxTokens?: number;
  /** Provider steps across the tree, not per agent. */
  maxSteps?: number;
  /** Wall clock from ledger creation, so a stalled tree also stops. */
  maxWallClockMs?: number;
}

export interface BudgetExceeded {
  dimension: 'tokens' | 'steps' | 'time';
  spent: number;
  limit: number;
}

/** A ledger with nothing configured never trips, so the default path stays free. */
export class BudgetLedger {
  private tokens = 0;
  private steps = 0;
  private readonly startedAt: number;
  readonly limits: BudgetLimits;

  constructor(limits: BudgetLimits = {}, private readonly now: () => number = Date.now) {
    this.limits = { ...limits };
    this.startedAt = this.now();
  }

  get active(): boolean {
    return this.limits.maxTokens !== undefined || this.limits.maxSteps !== undefined || this.limits.maxWallClockMs !== undefined;
  }

  get spent(): { tokens: number; steps: number; elapsedMs: number } {
    return { tokens: this.tokens, steps: this.steps, elapsedMs: this.now() - this.startedAt };
  }

  addUsage(usage: Usage): void {
    this.tokens += usage.totalTokens || usage.promptTokens + usage.completionTokens;
  }

  addStep(): void {
    this.steps++;
  }

  /** Remaining token room, or undefined when unlimited. */
  remainingTokens(): number | undefined {
    return this.limits.maxTokens === undefined ? undefined : Math.max(0, this.limits.maxTokens - this.tokens);
  }

  remainingMs(): number | undefined {
    return this.limits.maxWallClockMs === undefined ? undefined : Math.max(0, this.limits.maxWallClockMs - this.spent.elapsedMs);
  }

  /** The first ceiling already reached, if any. Cheapest check first. */
  check(): BudgetExceeded | undefined {
    const { elapsedMs } = this.spent;
    if (this.limits.maxWallClockMs !== undefined && elapsedMs >= this.limits.maxWallClockMs) {
      return { dimension: 'time', spent: elapsedMs, limit: this.limits.maxWallClockMs };
    }
    if (this.limits.maxSteps !== undefined && this.steps >= this.limits.maxSteps) {
      return { dimension: 'steps', spent: this.steps, limit: this.limits.maxSteps };
    }
    if (this.limits.maxTokens !== undefined && this.tokens >= this.limits.maxTokens) {
      return { dimension: 'tokens', spent: this.tokens, limit: this.limits.maxTokens };
    }
    return undefined;
  }

  /** A human-readable one-liner for a tool result the model can act on. */
  describe(exceeded: BudgetExceeded): string {
    switch (exceeded.dimension) {
      case 'time':
        return `the agent tree ran out of time after ${Math.round(exceeded.spent / 1000)}s of ${Math.round(exceeded.limit / 1000)}s`;
      case 'steps':
        return `the agent tree reached its ${exceeded.limit}-step budget`;
      default:
        return `the agent tree spent its ${exceeded.limit}-token budget (${exceeded.spent} used)`;
    }
  }
}
