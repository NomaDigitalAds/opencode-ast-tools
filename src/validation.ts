import path from "node:path"
import { Buffer } from "node:buffer"
import { HARD_LIMITS, LANGUAGES } from "./constants.js"
import { AstToolError } from "./errors.js"
import type { Language } from "./types.js"

const languageSet = new Set<string>(LANGUAGES)

export function validateLanguage(value: string): asserts value is Language {
  if (!languageSet.has(value)) {
    throw new AstToolError("UNSUPPORTED_LANGUAGE", `unsupported language: ${value}`)
  }
}

export function validateByteLength(
  value: string,
  label: string,
  allowEmpty = false,
  maximumBytes = HARD_LIMITS.patternBytes,
): void {
  const bytes = Buffer.byteLength(value)
  if ((!allowEmpty && bytes === 0) || bytes > maximumBytes) {
    const range = allowEmpty ? `0 to ${maximumBytes}` : `1 to ${maximumBytes}`
    throw new AstToolError("INVALID_ARGUMENT", `${label} must be ${range} UTF-8 bytes`)
  }
}

export function validateRelativePath(value: string, label = "path"): string {
  if (!value || value.includes("\0") || path.isAbsolute(value)) {
    throw new AstToolError("PATH_OUTSIDE_WORKTREE", `${label} must be a non-empty relative path`)
  }

  const normalized = value.replaceAll("\\", "/")
  if (normalized.split("/").includes("..")) {
    throw new AstToolError("PATH_OUTSIDE_WORKTREE", `${label} cannot contain '..' segments`)
  }
  return normalized
}

export function validatePaths(paths: string[] | undefined): string[] {
  const values = paths ?? ["."]
  if (values.length === 0 || values.length > HARD_LIMITS.paths) {
    throw new AstToolError("INVALID_ARGUMENT", `paths must contain 1 to ${HARD_LIMITS.paths} entries`)
  }
  return values.map((value, index) => validateRelativePath(value, `paths[${index}]`))
}

export function validateGlobs(values: string[] | undefined, label: string): string[] {
  if (!values) return []
  if (values.length > HARD_LIMITS.globs) {
    throw new AstToolError("INVALID_ARGUMENT", `${label} must contain at most ${HARD_LIMITS.globs} entries`)
  }
  return values.map((value, index) => {
    if (!value || value.includes("\0") || path.isAbsolute(value) || value.startsWith("!")) {
      throw new AstToolError("INVALID_ARGUMENT", `${label}[${index}] must be a relative glob without a leading '!'`)
    }
    const normalized = value.replaceAll("\\", "/")
    if (normalized.split("/").includes("..")) {
      throw new AstToolError("PATH_OUTSIDE_WORKTREE", `${label}[${index}] cannot contain '..' segments`)
    }
    return normalized
  })
}

export function validateInteger(value: number, label: string, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new AstToolError("INVALID_ARGUMENT", `${label} must be an integer from ${minimum} to ${maximum}`)
  }
}
