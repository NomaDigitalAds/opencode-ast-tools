import { AstToolError } from "./errors.js"
import type { AstEdit } from "./types.js"

export function prepareEdits(before: Buffer, edits: AstEdit[]): AstEdit[] {
  const unique = new Map<string, AstEdit>()
  for (const edit of edits) {
    if (
      edit.byteStart < 0 ||
      edit.byteEnd < edit.byteStart ||
      edit.byteEnd > before.length ||
      edit.matchStart < 0 ||
      edit.matchEnd < edit.matchStart ||
      edit.matchEnd > before.length
    ) {
      throw new AstToolError("ENGINE_OUTPUT_INVALID", "ast-grep returned an out-of-bounds edit")
    }
    if (before.subarray(edit.matchStart, edit.matchEnd).toString("utf8") !== edit.matchText) {
      throw new AstToolError("STALE_PLAN", "matched source no longer agrees with the engine output")
    }
    if (before.subarray(edit.byteStart, edit.byteEnd).equals(edit.replacement)) continue
    const key = `${edit.byteStart}:${edit.byteEnd}:${edit.replacement.toString("base64")}`
    if (!unique.has(key)) unique.set(key, edit)
  }

  const sorted = [...unique.values()].sort(
    (left, right) => left.byteStart - right.byteStart || left.byteEnd - right.byteEnd || left.operationIndex - right.operationIndex,
  )
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]
    const current = sorted[index]
    if (!previous || !current) continue
    if (current.byteStart < previous.byteEnd || current.byteStart === previous.byteStart) {
      throw new AstToolError(
        "OVERLAPPING_EDITS",
        `edits overlap at byte ${current.byteStart} (operations ${previous.operationIndex + 1} and ${current.operationIndex + 1})`,
      )
    }
  }
  return sorted
}

export function applyEdits(before: Buffer, edits: AstEdit[]): Buffer {
  const parts: Buffer[] = []
  let cursor = 0
  for (const edit of edits) {
    parts.push(before.subarray(cursor, edit.byteStart), edit.replacement)
    cursor = edit.byteEnd
  }
  parts.push(before.subarray(cursor))
  return Buffer.concat(parts)
}
