import type { SerializedError } from './events';

export class NosieError extends Error {
  code: string;
  details?: unknown;
  constructor(message: string, code = 'NOSIE_ERROR', details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
  toJSON(): SerializedError {
    return { name: this.name, message: this.message, code: this.code, details: this.details };
  }
}

export class ConfigError extends NosieError {
  constructor(message: string, details?: unknown) {
    super(message, 'CONFIG_ERROR', details);
  }
}

export class ProviderError extends NosieError {
  status?: number;
  retryable: boolean;
  constructor(message: string, opts: { status?: number; retryable?: boolean; details?: unknown } = {}) {
    super(message, 'PROVIDER_ERROR', opts.details);
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
  }
}

export class AuthError extends ProviderError {
  constructor(message: string, status?: number, details?: unknown) {
    super(message, { status, retryable: false, details });
    this.code = 'AUTH_ERROR';
  }
}

export class ContextOverflowError extends ProviderError {
  constructor(message: string, details?: unknown) {
    super(message, { status: 400, retryable: false, details });
    this.code = 'CONTEXT_OVERFLOW';
  }
}

export class OutputLengthError extends NosieError {
  constructor(message = 'Model output truncated by max_tokens') {
    super(message, 'OUTPUT_LENGTH');
  }
}

export class ToolNotFoundError extends NosieError {
  toolName: string;
  constructor(toolName: string) {
    super(`Tool not found: ${toolName}`, 'TOOL_NOT_FOUND');
    this.toolName = toolName;
  }
}

export class InvalidToolArgsError extends NosieError {
  toolName: string;
  constructor(toolName: string, message: string, details?: unknown) {
    super(`Invalid arguments for ${toolName}: ${message}`, 'INVALID_TOOL_ARGS', details);
    this.toolName = toolName;
  }
}

export class ToolExecutionError extends NosieError {
  toolName: string;
  constructor(toolName: string, message: string, details?: unknown) {
    super(message, 'TOOL_EXECUTION_ERROR', details);
    this.toolName = toolName;
  }
}

export class PermissionDeniedError extends NosieError {
  toolName: string;
  constructor(toolName: string, message?: string) {
    super(message ?? `Permission denied for tool ${toolName}`, 'PERMISSION_DENIED');
    this.toolName = toolName;
  }
}

export class MaxStepsError extends NosieError {
  constructor(steps: number) {
    super(`Maximum steps reached (${steps})`, 'MAX_STEPS');
  }
}

export class AbortedError extends NosieError {
  constructor(message = 'Aborted') {
    super(message, 'ABORTED');
  }
}

export class SandboxViolationError extends NosieError {
  constructor(inputPath: string, reason: string) {
    super(`Path "${inputPath}" rejected: ${reason}`, 'SANDBOX_VIOLATION', { inputPath });
  }
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof NosieError) return err.toJSON();
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  return { name: 'Error', message: String(err) };
}

export function isAbortError(err: unknown): boolean {
  return (
    err instanceof AbortedError ||
    (err instanceof Error && (err.name === 'AbortError' || (err as { code?: string }).code === 'ABORT_ERR'))
  );
}
