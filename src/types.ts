import type { LANGUAGES } from "./constants.js"

export type Language = (typeof LANGUAGES)[number]

export type Position = {
  line: number
  column: number
}

export type AstRange = {
  byteStart: number
  byteEnd: number
  start: Position
  end: Position
}

export type AstSearchMatch = {
  path: string
  language: string
  range: AstRange
  text: string
  captures?: Record<string, string>
  context: string
}

export type AstSearchResult = {
  engine: { name: "ast-grep"; version: string }
  worktree: string
  matches: AstSearchMatch[]
  totalSeen: number
  truncated: boolean
  warnings: string[]
}

export type AstEdit = {
  byteStart: number
  byteEnd: number
  replacement: Buffer
  matchStart: number
  matchEnd: number
  matchText: string
  operationIndex: number
}

export type PlannedFile = {
  relativePath: string
  realPath: string
  before: Buffer
  after: Buffer
  beforeSha256: string
  afterSha256: string
  mode: number
  replacements: number
}

export type StoredPlan = {
  id: string
  sessionId: string
  realWorktree: string
  createdAt: number
  expiresAt: number
  pluginVersion: string
  engineVersion: string
  files: PlannedFile[]
}

export type PluginConfig = {
  limits: {
    maxSearchResults: number
    maxChangedFiles: number
    maxReplacements: number
    planTtlSeconds: number
  }
  respectGitignore: boolean
  allowIgnoredFiles: boolean
}
