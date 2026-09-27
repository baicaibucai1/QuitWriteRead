import type { SubagentDefinition } from '../types/config';
import type { CumulativeUsage } from '../types/events';
import { defineTool, type Tool } from '../types/tools';
import { truncateMiddle } from '../utils';

export interface DelegationResult {
  text: string;
  stopReason: string;
  steps: number;
  usage: CumulativeUsage;
  /** Child agent id, for a host that wants to correlate logs. */
  sessionId: string;
}

export interface Delegation {
  /**
   * Runs one child to completion. `report` is called with a line per notable
   * child event, which reaches the host as `tool_progress` on this tool call -
   * so a delegation shows its work without the host learning anything new.
   */
  run(definition: SubagentDefinition, task: string, report: (line: string) => void, signal: AbortSignal): Promise<DelegationResult>;
}

/**
 * The delegating tool the model sees. Kept separate from the runtime so a host
 * can register `task` against any executor it likes; `createAgent` wires it to
 * real child agents.
 */
export function createTaskTool(definitions: SubagentDefinition[], delegation: Delegation): Tool {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const roster = definitions.map((definition) => `${definition.name}: ${definition.description}`).join(' | ');

  return defineTool<Record<string, string>>({
    name: 'task',
    description: `Delegate one self-contained subtask to a specialist agent and get its final answer. The subagent cannot see this conversation, so put every fact it needs into "task", and do not give it work whose result you must not re-derive. Available agents - ${roster}`,
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: [...byName.keys()], description: 'Which specialist to delegate to.' },
        task: { type: 'string', description: 'The complete, self-contained instructions for the subagent.' },
      },
      required: ['agent', 'task'],
    },
    kind: 'think',
    primaryArg: 'task',
    // Deliberately not an approval point: the subagent's own tool calls still go
    // through the permission pipeline, so gating the delegation as well would
    // ask the human twice for the same decision.
    needsApproval: false,
    readOnly: false,
    // Two delegations in one step are independent runs, and running them
    // together is the usual reason to delegate at all.
    concurrency: 'parallel',
    title: (args) => `task(${args.agent ?? '?'}): ${truncateMiddle(args.task ?? '', 70, ' … ')}`,
    async execute(args, ctx) {
      const definition = byName.get(args.agent ?? '');
      if (!definition) {
        return { content: `Unknown subagent "${args.agent}". Available: ${[...byName.keys()].join(', ')}`, isError: true };
      }
      const task = (args.task ?? '').trim();
      if (!task) return { content: 'task must be a non-empty instruction for the subagent.', isError: true };
      if (ctx.signal.aborted) return { content: 'Delegation cancelled before it started.', isError: true };

      const result = await delegation.run(definition, task, ctx.progress, ctx.signal);
      return {
        content: result.text.trim() || `The ${definition.name} subagent finished with ${result.stopReason} and no text.`,
        isError: result.stopReason === 'error',
        meta: {
          subagent: definition.name,
          subagentSession: result.sessionId,
          steps: result.steps,
          stopReason: result.stopReason,
          usage: result.usage,
        },
        display: { kind: 'text' },
      };
    },
  });
}
