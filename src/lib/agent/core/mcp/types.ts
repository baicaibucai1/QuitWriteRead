export interface McpStdioConfig {
  name: string;
  transport: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHttpConfig {
  name: string;
  transport: 'http';
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export interface McpWarning {
  server: string;
  message: string;
}

export const MCP_TOOL_PREFIX = 'mcp__';

export function mcpToolName(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${server}__${tool}`;
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

export function unwrapMcpToolName(name: string): { server: string; tool: string } | undefined {
  if (!isMcpToolName(name)) return undefined;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const idx = rest.indexOf('__');
  if (idx <= 0) return undefined;
  return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) };
}
