/**
 * The one place this version is written.
 *
 * It used to live in four: this module, the MCP client metadata, the sidecar's
 * `agentInfo`, and the demo's own override of it. Bumping `package.json` alone left
 * the CLI, the `initialize` handshake and every MCP server telling counterparties
 * the previous version — a lie no type check catches, because a string is a string.
 *
 * Pinned by tests/version.test.ts, which scans src/, demo/ and examples/ rather
 * than just src/: the fourth copy was in the demo, and a src-only scan would have
 * passed while a connecting client kept reading the stale number.
 */
export const VERSION = '0.2.0';
