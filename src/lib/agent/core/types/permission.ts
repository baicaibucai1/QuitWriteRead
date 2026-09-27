export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'other';

export type PermissionMode = 'readOnly' | 'default' | 'acceptEdits' | 'bypassPermissions';

export type PermissionOptionId = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface PermissionOption {
  optionId: PermissionOptionId;
  name: string;
  kind: PermissionOptionId;
}

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message?: string }
  | { behavior: 'ask'; reason?: string };

export interface PermissionResponse {
  optionId: PermissionOptionId | 'cancelled';
  updatedInput?: Record<string, unknown>;
  message?: string;
}

export interface PermissionRule {
  tool: string;
  argPattern?: string;
}

export interface PermissionConfig {
  mode?: PermissionMode;
  allow?: Array<string | PermissionRule>;
  deny?: Array<string | PermissionRule>;
  ask?: Array<string | PermissionRule>;
  dangerouslyAllowAll?: boolean;
  onRequest?: (request: import('./events').PermissionRequest, signal: AbortSignal) => Promise<PermissionResponse> | PermissionResponse;
}

export const PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
  { optionId: 'reject_always', name: 'Always reject', kind: 'reject_always' },
];
