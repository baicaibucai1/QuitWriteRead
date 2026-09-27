import os from 'node:os';
import type { PromptEnv } from '../types/config';
import type { SkillRegistry } from '../skills/loader';
import type { MemoryStores } from '../memory/store';
import { MEMORY_TOOL_GUIDANCE } from '../memory/store';

export const BASE_PROMPT = `You are NosieAgentCore, an agent embedded in a host application. You work on real tasks with real tools and you are accountable for the outcome.

## Working style
- Do the work. When you say you will do something, emit the tool call for it in the same turn; never stop at announcing intent.
- Read before you change. Use grep/glob/read_file to gather evidence rather than guessing about files, APIs or conventions.
- Prefer editing existing files to creating new ones, and never write documentation or analysis files the user did not ask for.
- Do not add features, refactors, abstractions, comments or error handling beyond what the task requires.
- Match the user's language. Keep technical terms in their original form.
- Only use emojis if the user explicitly asks for them.

## Tool discipline
- Tools run inside a workspace sandbox; paths outside it are rejected by design.
- A permission system may ask the user before write or execute tools run. Never retry a denied action unchanged, and never work around a denial through another tool.
- When a tool returns an error, read the message, diagnose the cause, and fix the underlying issue. Do not loop on the same failing call.
- Independent tool calls should be issued together; dependent ones must wait.
- Tool output may be truncated; the message says so. Re-read with an offset instead of assuming you saw everything.

## Verification
- Treat "it compiles" as different from "it works". For behavior, run it.
- When you cannot verify a change, say so explicitly instead of claiming success.

## Context
Your context window is finite and degrades as it fills. Long tool outputs and old turns may be compacted away. If you learn something that must survive, put it in your output or memory rather than relying on it staying visible.`;

export interface PromptSection {
  id: string;
  title?: string;
  content: string;
}

export interface BuildPromptOptions {
  workspaceRoot: string;
  homeDir?: string;
  model: string;
  systemPrompt?: string | ((env: PromptEnv) => string | Promise<string>);
  includeBase?: boolean;
  skills?: SkillRegistry;
  memory?: MemoryStores;
  instructions?: boolean;
  instructionFileNames?: string[];
  instructionMaxBytes?: number;
  env?: Partial<PromptEnv>;
}

export interface BuiltPrompt {
  text: string;
  sections: PromptSection[];
  warnings: Array<{ code: string; message: string }>;
}

export async function buildSystemPrompt(opts: BuildPromptOptions): Promise<BuiltPrompt> {
  const sections: PromptSection[] = [];
  const warnings: BuiltPrompt['warnings'] = [];
  const homeDir = opts.homeDir ?? os.homedir();

  if (opts.includeBase !== false) sections.push({ id: 'base', content: BASE_PROMPT });

  if (opts.systemPrompt) {
    const host = typeof opts.systemPrompt === 'function' ? await opts.systemPrompt(promptEnv(opts, homeDir)) : opts.systemPrompt;
    if (host.trim()) sections.push({ id: 'host', title: 'Host instructions', content: host.trim() });
  }

  /*
   * 指令链（AGENTS.md / NOSIE.md 那一套）在浏览器端不加载：它要扫磁盘。
   * 想让"每一步都必须看见的规则"生效，用内核自己的 `injectedPrompts`
   * —— 那条通道不进 transcript，压缩也吃不掉，本来就是干这个的。
   */

  if (opts.memory && opts.memory.all().length) {
    const indexes = await Promise.all(opts.memory.all().map((s) => s.renderIndex()));
    const rendered = indexes.map((text, i) => (text.trim() ? `### ${opts.memory!.all()[i]!.scope} memory\n\n${text.trim()}` : '')).filter(Boolean);
    if (rendered.length) {
      sections.push({ id: 'memory-guidance', content: MEMORY_TOOL_GUIDANCE });
      sections.push({ id: 'memory-index', title: 'Memory index', content: rendered.join('\n\n') });
    }
  }

  if (opts.skills && opts.skills.count) {
    sections.push({ id: 'skills', title: 'Available skills', content: opts.skills.renderCatalog() });
  }

  sections.push({ id: 'environment', content: renderEnv(promptEnv(opts, homeDir)) });

  return { text: sections.map((s) => s.content).join('\n\n'), sections, warnings };
}

function promptEnv(opts: BuildPromptOptions, homeDir: string): PromptEnv {
  return {
    cwd: opts.workspaceRoot,
    platform: process.platform,
    date: new Date().toISOString().slice(0, 10),
    model: opts.model,
    home: homeDir,
    ...opts.env,
  };
}

function renderEnv(env: PromptEnv): string {
  return [
    '# Environment',
    `- Working directory: ${env.cwd}`,
    `- Platform: ${env.platform} (${os.arch()})`,
    `- Model: ${env.model}`,
    `- Date: ${env.date}`,
    `- Home: ${env.home ?? os.homedir()}`,
  ].join('\n');
}
