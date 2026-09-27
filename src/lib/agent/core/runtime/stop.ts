import type { AssistantMessage } from '../types/messages';

export interface StopState {
  step: number;
  steps: AssistantMessage[];
  lastMessage?: AssistantMessage;
  totalTokens: number;
}

export type StopCondition = (state: StopState) => boolean | Promise<boolean>;

export function stepCountIs(n: number): StopCondition {
  return (s) => s.step >= n;
}

export function hasToolCall(name: string): StopCondition {
  return (s) => (s.lastMessage?.parts ?? []).some((p) => p.type === 'tool_call' && p.name === name);
}

export function isStopConditionArray(v: unknown): v is StopCondition[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'function');
}

export async function shouldStop(cond: StopCondition | StopCondition[] | undefined, state: StopState): Promise<boolean> {
  if (!cond) return false;
  const list = Array.isArray(cond) ? cond : [cond];
  for (const c of list) if (await c(state)) return true;
  return false;
}
