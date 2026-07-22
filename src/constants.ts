export const PLUGIN_VERSION = "0.1.0"
export const ENGINE_VERSION = "0.44.1"

export const LANGUAGES = [
  "bash",
  "c",
  "cpp",
  "csharp",
  "css",
  "elixir",
  "go",
  "haskell",
  "html",
  "java",
  "javascript",
  "json",
  "kotlin",
  "lua",
  "nix",
  "php",
  "python",
  "ruby",
  "rust",
  "scala",
  "solidity",
  "swift",
  "typescript",
  "tsx",
  "yaml",
] as const

export const HARD_LIMITS = {
  paths: 32,
  globs: 32,
  operations: 16,
  patternBytes: 8 * 1024,
  replacementBytes: 8 * 1024,
  fileBytes: 5 * 1024 * 1024,
  searchResults: 200,
  changedFiles: 200,
  replacements: 2_000,
  engineOutputBytes: 8 * 1024 * 1024,
  modelOutputBytes: 1024 * 1024,
  planTtlSeconds: 3_600,
  plans: 32,
  planStoreBytes: 64 * 1024 * 1024,
} as const

export const DEFAULTS = {
  contextLines: 1,
  maxSearchResults: 50,
  maxChangedFiles: 50,
  maxReplacements: 500,
  planTtlSeconds: 900,
  searchTimeoutMs: 30_000,
  replaceTimeoutMs: 60_000,
} as const
