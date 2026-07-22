import { DEFAULTS, HARD_LIMITS } from "./constants.js"
import { AstToolError } from "./errors.js"
import type { PluginConfig } from "./types.js"

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) return {}
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AstToolError("INVALID_ARGUMENT", `${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function integer(
  value: unknown,
  fallback: number,
  label: string,
  maximum: number,
): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new AstToolError("INVALID_ARGUMENT", `${label} must be an integer from 1 to ${maximum}`)
  }
  return value as number
}

function boolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") {
    throw new AstToolError("INVALID_ARGUMENT", `${label} must be a boolean`)
  }
  return value
}

export function parseConfig(value: unknown): PluginConfig {
  const config = object(value, "plugin config")
  const limits = object(config.limits, "limits")

  return {
    limits: {
      maxSearchResults: integer(
        limits.maxSearchResults,
        DEFAULTS.maxSearchResults,
        "limits.maxSearchResults",
        HARD_LIMITS.searchResults,
      ),
      maxChangedFiles: integer(
        limits.maxChangedFiles,
        DEFAULTS.maxChangedFiles,
        "limits.maxChangedFiles",
        HARD_LIMITS.changedFiles,
      ),
      maxReplacements: integer(
        limits.maxReplacements,
        DEFAULTS.maxReplacements,
        "limits.maxReplacements",
        HARD_LIMITS.replacements,
      ),
      planTtlSeconds: integer(
        limits.planTtlSeconds,
        DEFAULTS.planTtlSeconds,
        "limits.planTtlSeconds",
        HARD_LIMITS.planTtlSeconds,
      ),
    },
    respectGitignore: boolean(config.respectGitignore, true, "respectGitignore"),
    allowIgnoredFiles: boolean(config.allowIgnoredFiles, false, "allowIgnoredFiles"),
  }
}
