import { describe, expect, it } from "vitest"
import { applyEdits, prepareEdits } from "../src/edits.js"
import type { AstEdit } from "../src/types.js"

function edit(start: number, end: number, replacement: string, operationIndex = 0): AstEdit {
  return {
    byteStart: start,
    byteEnd: end,
    replacement: Buffer.from(replacement),
    matchStart: start,
    matchEnd: end,
    matchText: "abcdef".slice(start, end),
    operationIndex,
  }
}

describe("byte edits", () => {
  it("deduplicates identical edits and applies from the end", () => {
    const before = Buffer.from("abcdef")
    const edits = prepareEdits(before, [edit(1, 3, "X"), edit(1, 3, "X"), edit(4, 6, "Y")])
    expect(edits).toHaveLength(2)
    expect(applyEdits(before, edits).toString()).toBe("aXdY")
  })

  it("preserves multibyte bytes outside the changed range", () => {
    const before = Buffer.from("á = old\r\n")
    const start = Buffer.byteLength("á = ")
    const edits: AstEdit[] = [{
      byteStart: start,
      byteEnd: start + 3,
      replacement: Buffer.from("new"),
      matchStart: start,
      matchEnd: start + 3,
      matchText: "old",
      operationIndex: 0,
    }]
    expect(applyEdits(before, prepareEdits(before, edits))).toEqual(Buffer.from("á = new\r\n"))
  })

  it("rejects overlapping edits before applying anything", () => {
    const before = Buffer.from("abcdef")
    expect(() => prepareEdits(before, [edit(1, 4, "X"), edit(3, 5, "Y", 1)])).toThrowError(
      "OVERLAPPING_EDITS",
    )
  })

  it("rejects an engine match that disagrees with current bytes", () => {
    const before = Buffer.from("abcdef")
    const stale = { ...edit(1, 3, "X"), matchText: "wrong" }
    expect(() => prepareEdits(before, [stale])).toThrowError("STALE_PLAN")
  })
})
