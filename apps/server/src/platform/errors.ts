/**
 * platform/errors.ts
 */
export type ErrorCode =
  | 'VALIDATION_DENIED'
  | 'NOT_FOUND'
  | 'NOT_PROJECT_MEMBER'
  | 'AGENT_DISABLED'
  | 'ILLEGAL_TRANSITION'
  | 'WORKSPACE_INVALID'
  | 'SCHEDULER_DISABLED'
  | 'COMMAND_DENIED'
  | 'CONFLICT'
  | 'AGENT_BUSY'
  | 'INTERNAL';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly statusCode = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: ErrorCode, msg: string, details?: unknown): AppError =>
  new AppError(code, msg, 400, details);
export const notFound = (msg: string): AppError => new AppError('NOT_FOUND', msg, 404);
export const conflict = (code: ErrorCode, msg: string): AppError => new AppError(code, msg, 409);
