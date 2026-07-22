import { describe, expect, it } from "vitest"
import { chunkEnginePaths, runEngine, type EngineRequest } from "../src/engine/cli.js"

const engine = { executable: "C:/program files/ast-grep.exe", version: "0.44.1" }

function request(paths: string[]): EngineRequest {
  return {
    pattern: "console.log($ARG)",
    language: "typescript",
    paths,
    include: [],
    exclude: [],
    contextLines: 0,
    respectGitignore: true,
    allowIgnoredFiles: false,
    timeoutMs: 30_000,
    signal: new AbortController().signal,
    cwd: "C:/workspace",
  }
}

describe("ast-grep command chunking", () => {
  it("preserves every literal path in order while staying in bounded chunks", () => {
    const paths = Array.from(
      { length: 2_000 },
      (_, index) => `src/long directory/[literal]-${String(index).padStart(5, "0")}-${"x".repeat(30)}.ts`,
    )
    const chunks = chunkEnginePaths(engine, request(paths))

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.flat()).toEqual(paths)

    const unicodePaths = Array.from({ length: 1_000 }, (_, index) => `src/${"😀".repeat(10)}-${index}.ts`)
    expect(chunkEnginePaths(engine, request(unicodePaths)).flat()).toEqual(unicodePaths)
  })

  it("returns an empty result without spawning for an empty manifest", async () => {
    await expect(runEngine({ executable: "missing", version: "0.44.1" }, request([]))).resolves.toEqual({
      matches: [],
      warnings: [],
      outputBytes: 0,
    })
  })

  it("rejects fixed arguments that leave no room for one path", () => {
    const oversized = request(["src/main.ts"])
    oversized.pattern = "\\".repeat(8_192)
    oversized.replacement = "\\".repeat(8_192)
    expect(() => chunkEnginePaths(engine, oversized)).toThrowError("LIMIT_EXCEEDED")
  })
})
