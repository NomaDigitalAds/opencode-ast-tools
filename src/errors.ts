export type AstToolErrorCode =
  | "INVALID_ARGUMENT"
  | "UNSUPPORTED_LANGUAGE"
  | "PATTERN_PARSE_ERROR"
  | "FILE_PARSE_ERROR"
  | "PATH_OUTSIDE_WORKTREE"
  | "PATH_NOT_FOUND"
  | "PERMISSION_DENIED"
  | "LIMIT_EXCEEDED"
  | "OVERLAPPING_EDITS"
  | "ENGINE_TIMEOUT"
  | "ENGINE_OUTPUT_INVALID"
  | "PLAN_NOT_FOUND"
  | "PLAN_EXPIRED"
  | "PLAN_OWNER_MISMATCH"
  | "STALE_PLAN"
  | "STAGING_FAILED"
  | "COMMIT_PARTIAL"
  | "ABORTED"

export class AstToolError extends Error {
  readonly code: AstToolErrorCode

  constructor(code: AstToolErrorCode, message: string, options?: ErrorOptions) {
    super(`[${code}] ${message}`, options)
    this.name = "AstToolError"
    this.code = code
  }
}
