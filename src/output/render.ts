import { HARD_LIMITS } from "../constants.js"
import type { AstSearchResult, StoredPlan } from "../types.js"
import { truncateUtf8 } from "./truncate.js"

function terminalSafe(value: string): string {
  return value
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
}

function bounded(value: string): string {
  return truncateUtf8(value, HARD_LIMITS.modelOutputBytes, "\n... output truncated\n").text
}

export function renderSearch(result: AstSearchResult): string {
  const output = [
    `ast-grep ${result.engine.version}: ${result.matches.length} match(es), ${result.totalSeen} seen${result.truncated ? " (truncated)" : ""}`,
  ]
  if (result.discovery.truncated) {
    output.push(`warning: scope exceeded ${result.discovery.limit} eligible files; searched the first ${result.discovery.files}`)
  }
  let currentPath = ""
  for (const match of result.matches) {
    if (match.path !== currentPath) {
      currentPath = match.path
      output.push(`\n${terminalSafe(match.path)}`)
    }
    const { start, end } = match.range
    output.push(
      `  ${start.line}:${start.column}-${end.line}:${end.column} [bytes ${match.range.byteStart}..${match.range.byteEnd}]`,
      terminalSafe(match.context || match.text)
        .split(/\r?\n/)
        .map((line) => `    ${line}`)
        .join("\n"),
    )
  }
  for (const warning of result.warnings) output.push(`warning: ${terminalSafe(warning)}`)
  return bounded(output.join("\n"))
}

export type PreviewFile = {
  path: string
  replacements: number
  beforeSha256: string
  afterSha256: string
  diff: string
  diffTruncated: boolean
}

export function renderPreview(plan: StoredPlan, files: PreviewFile[]): string {
  const output = [
    `Preview only. Does not modify files. Plan ${plan.id} expires at ${new Date(plan.expiresAt).toISOString()}.`,
    `${files.length} file(s), ${files.reduce((total, file) => total + file.replacements, 0)} replacement(s).`,
  ]
  for (const file of files) {
    output.push(`\n${terminalSafe(file.path)} (${file.replacements} replacement(s))`, terminalSafe(file.diff))
  }
  return bounded(output.join("\n"))
}

export function renderApply(plan: StoredPlan): string {
  return [
    `Applied plan ${plan.id} to ${plan.files.length} file(s).`,
    ...plan.files.map((file) => `${terminalSafe(file.relativePath)} ${file.afterSha256}`),
  ].join("\n")
}
