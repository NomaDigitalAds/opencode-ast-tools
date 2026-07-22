import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"
import { truncateUtf8 } from "../src/output/truncate.js"

describe("model output limits", () => {
  it("truncates on a UTF-8 boundary within the byte cap", () => {
    const result = truncateUtf8("á".repeat(20), 12, "...")
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(12)
    expect(result.text).not.toContain("�")
  })
})
