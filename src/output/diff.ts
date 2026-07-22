import { Buffer } from "node:buffer"
import { truncateUtf8 } from "./truncate.js"

export type DiffResult = {
  text: string
  truncated: boolean
}

function lines(value: Buffer): string[] {
  return value.toString("utf8").split(/(?<=\n)/)
}

function withoutEnding(value: string): string {
  return value.replace(/\r?\n$/, "")
}

export function createUnifiedDiff(path: string, before: Buffer, after: Buffer, maximumBytes: number): DiffResult {
  const beforeLines = lines(before)
  const afterLines = lines(after)
  let prefix = 0
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - suffix - 1] === afterLines[afterLines.length - suffix - 1]
  ) {
    suffix += 1
  }

  const contextStart = Math.max(0, prefix - 3)
  const beforeEnd = Math.min(beforeLines.length, beforeLines.length - suffix + 3)
  const afterEnd = Math.min(afterLines.length, afterLines.length - suffix + 3)
  const oldCount = beforeEnd - contextStart
  const newCount = afterEnd - contextStart
  const output = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${contextStart + 1},${oldCount} +${contextStart + 1},${newCount} @@`,
  ]
  for (const line of beforeLines.slice(contextStart, prefix)) output.push(` ${withoutEnding(line)}`)
  for (const line of beforeLines.slice(prefix, beforeLines.length - suffix)) output.push(`-${withoutEnding(line)}`)
  for (const line of afterLines.slice(prefix, afterLines.length - suffix)) output.push(`+${withoutEnding(line)}`)
  for (const line of afterLines.slice(afterLines.length - suffix, afterEnd)) output.push(` ${withoutEnding(line)}`)
  return truncateUtf8(`${output.join("\n")}\n`, maximumBytes, "\n... diff truncated\n")
}
