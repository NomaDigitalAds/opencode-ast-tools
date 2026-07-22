import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"
import { renderSearch } from "../src/output/render.js"
import { truncateUtf8 } from "../src/output/truncate.js"

describe("model output limits", () => {
  it("truncates on a UTF-8 boundary within the byte cap", () => {
    const result = truncateUtf8("á".repeat(20), 12, "...")
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(12)
    expect(result.text).not.toContain("�")
  })

  it("reports file-discovery truncation separately from match truncation", () => {
    const output = renderSearch({
      engine: { name: "ast-grep", version: "0.44.1" },
      worktree: ".",
      matches: [],
      totalSeen: 0,
      truncated: false,
      discovery: { files: 10_000, limit: 10_000, truncated: true },
      warnings: [],
    })
    expect(output).toContain("scope exceeded 10000 eligible files")
    expect(output).toContain("searched the first 10000")
  })
})
