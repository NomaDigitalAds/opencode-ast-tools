import { describe, expect, it } from "vitest"
import { flattenCaptures, parseEngineJson } from "../src/engine/json.js"

const output = JSON.stringify([
  {
    text: "console.log(value)",
    range: {
      byteOffset: { start: 3, end: 21 },
      start: { line: 1, column: 2 },
      end: { line: 1, column: 20 },
    },
    file: "src/main.ts",
    lines: "  console.log(value)\n",
    charCount: { leading: 2, trailing: 1 },
    replacement: "logger.info(value)",
    replacementOffsets: { start: 3, end: 21 },
    language: "TypeScript",
    metaVariables: {
      single: {
        ARG: {
          text: "value",
          range: {
            byteOffset: { start: 15, end: 20 },
            start: { line: 1, column: 14 },
            end: { line: 1, column: 19 },
          },
        },
      },
      multi: {},
      transformed: {},
    },
  },
])

describe("ast-grep JSON", () => {
  it("parses compact output without losing byte offsets", () => {
    const [match] = parseEngineJson(output)
    expect(match?.range.byteOffset).toEqual({ start: 3, end: 21 })
    expect(match?.replacementOffsets).toEqual({ start: 3, end: 21 })
    expect(flattenCaptures(match?.metaVariables)).toEqual({ ARG: "value" })
  })

  it.each(["", "{}", "[{\"text\":1}]"]) ("rejects invalid output %s", (value) => {
    expect(() => parseEngineJson(value)).toThrowError("ENGINE_OUTPUT_INVALID")
  })
})
