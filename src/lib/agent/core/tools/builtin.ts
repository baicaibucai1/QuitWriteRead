import os from 'node:os';
import path from 'node:path';
import type { AgentConfig, BuiltinToolName } from '../types/config';
import type { Tool } from '../types/tools';
import { createMemoryTools } from './memory-tools';
import { createSkillTool, type SkillRegistry } from '../skills/loader';
import type { MemoryStores } from '../memory/store';
import { noopLogger } from '../utils';

export const ALL_BUILTIN_TOOLS: BuiltinToolName[] = [
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'glob',
  'grep',
  'shell',
  'memory_save',
  'memory_search',
  'memory_forget',
  'skill',
  // Registered only when the host declares subagents; listed here because
  // `builtinTools: true` means "every built-in", and a name missing from this
  // array would make the default configuration silently undelegatable.
  'task',
];

export const READ_ONLY_BUILTINS: BuiltinToolName[] = ['read_file', 'list_dir', 'glob', 'grep'];

export interface BuiltinOptions {
  config: AgentConfig;
  skills?: SkillRegistry;
  memory?: MemoryStores;
}

export function resolveBuiltinSelection(selection: boolean | BuiltinToolName[] | undefined): Set<BuiltinToolName> {
  if (selection === false) return new Set();
  if (Array.isArray(selection)) return new Set(selection);
  return new Set(ALL_BUILTIN_TOOLS);
}

export function createBuiltinTools(opts: BuiltinOptions): Tool[] {
  const { config } = opts;
  const enabled = resolveBuiltinSelection(config.builtinTools);
  const tools: Tool[] = [];

  /*
   * ⛔ 内置的文件工具与 shell 工具在浏览器端**不存在**（上游那两个实现靠 node:fs /
   * child_process，已随文件一起删掉）。笔记读写一律走宿主自己的工具层
   * （lib/agent/note-tools.ts，底下是 Repo 接口）—— 那里天然只认仓库内相对路径，
   * 比"把整个家目录交给模型"安全得多。
   */

  if (opts.memory && opts.memory.all().length) {
    for (const t of createMemoryTools(opts.memory)) if (enabled.has(t.name as BuiltinToolName)) tools.push(t);
  }

  if (opts.skills && opts.skills.count > 0 && enabled.has('skill')) tools.push(createSkillTool(opts.skills));

  return tools;
}

export function defaultHomeDir(): string {
  return process.env.NOSIE_HOME ? path.resolve(process.env.NOSIE_HOME) : os.homedir();
}

export function defaultWorkspaceRoot(): string {
  return process.cwd();
}

export { noopLogger };
