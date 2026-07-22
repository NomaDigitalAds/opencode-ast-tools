import path from "node:path"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it } from "vitest"
import { HARD_LIMITS } from "../src/constants.js"
import { discoverFiles, type DiscoveryRequest } from "../src/filesystem/discovery.js"
import { PlanStore } from "../src/plans/store.js"
import { createReplaceTool } from "../src/tools/replace.js"

const directories: string[] = []

async function fixture(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-ast-discovery-"))
  const canonical = await realpath(directory)
  directories.push(canonical)
  return canonical
}

function request(realWorktree: string, overrides: Partial<DiscoveryRequest> = {}): DiscoveryRequest {
  return {
    realWorktree,
    scopes: ["."],
    language: "typescript",
    include: [],
    exclude: [],
    respectGitignore: true,
    allowIgnoredFiles: false,
    signal: new AbortController().signal,
    deadline: Date.now() + 120_000,
    ...overrides,
  }
}

async function writeManyFiles(directory: string, count: number): Promise<void> {
  const shards = Math.ceil(count / 250)
  await Promise.all(Array.from({ length: shards }, (_, index) => mkdir(path.join(directory, String(index).padStart(3, "0")))))
  let next = 0
  await Promise.all(Array.from({ length: 64 }, async () => {
    while (next < count) {
      const index = next
      next += 1
      const shard = String(Math.floor(index / 250)).padStart(3, "0")
      await writeFile(path.join(directory, shard, `${String(index).padStart(5, "0")}.ts`), "const value = 1\n")
    }
  }))
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
}, 120_000)

describe("bounded file discovery", () => {
  it("does not start filesystem work after abort or deadline", async () => {
    const directory = await fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(discoverFiles(request(directory, {
      scopes: ["missing"],
      signal: controller.signal,
    }))).rejects.toMatchObject({ code: "ABORTED" })
    await expect(discoverFiles(request(directory, {
      scopes: ["missing"],
      deadline: Date.now() - 1,
    }))).rejects.toMatchObject({ code: "ENGINE_TIMEOUT" })
  })

  it("stops deterministically after 10,000 eligible files", async () => {
    const directory = await fixture()
    const source = path.join(directory, "src")
    await mkdir(source)
    await writeManyFiles(source, HARD_LIMITS.discoveredFiles + 1)

    const result = await discoverFiles(request(directory, { scopes: ["src"], respectGitignore: false }))

    expect(result).toMatchObject({
      files: HARD_LIMITS.discoveredFiles,
      limit: HARD_LIMITS.discoveredFiles,
      truncated: true,
    })
    expect(result.paths[0]).toBe("src/000/00000.ts")
    expect(result.paths.at(-1)).toBe("src/039/09999.ts")

    const replace = createReplaceTool(
      { executable: "must-not-run", version: "0.44.1" },
      {
        limits: { maxSearchResults: 50, maxChangedFiles: 50, maxReplacements: 500, planTtlSeconds: 900 },
        respectGitignore: false,
        allowIgnoredFiles: false,
      },
      new PlanStore(60_000),
    )
    await expect(replace.execute(
      {
        operations: [{ pattern: "const $A = $B", replacement: "let $A = $B" }],
        language: "typescript",
        paths: ["src"],
      },
      {
        sessionID: "phase-3",
        messageID: "phase-3",
        agent: "test",
        directory,
        worktree: directory,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
      },
    )).rejects.toThrowError("no plan was created")

    await rm(path.join(source, "040", "10000.ts"))
    const exact = await discoverFiles(request(directory, { scopes: ["src"], respectGitignore: false }))
    expect(exact).toMatchObject({ files: HARD_LIMITS.discoveredFiles, truncated: false })
  }, 120_000)

  it("preserves ignore, hidden, override, and literal path behavior", async () => {
    const directory = await fixture()
    await Promise.all([
      mkdir(path.join(directory, "src", "generated"), { recursive: true }),
      mkdir(path.join(directory, "src", "nested"), { recursive: true }),
      mkdir(path.join(directory, "src", ".hidden"), { recursive: true }),
    ])
    await Promise.all([
      writeFile(path.join(directory, ".gitignore"), "src/generated/\n"),
      writeFile(path.join(directory, ".git"), "gitdir: ../linked-worktree\n"),
      writeFile(path.join(directory, "src", ".gitignore"), "nested/*.ts\n"),
      writeFile(path.join(directory, "src", ".ignore"), "!nested/keep.ts\n"),
      writeFile(path.join(directory, "src", "main.ts"), "const main = 1\n"),
      writeFile(path.join(directory, "src", "[id].ts"), "const id = 1\n"),
      writeFile(path.join(directory, "src", "module.cts"), "const module = 1\n"),
      writeFile(path.join(directory, "src", "other.js"), "const other = 1\n"),
      writeFile(path.join(directory, "src", "generated", "keep.ts"), "const generated = 1\n"),
      writeFile(path.join(directory, "src", "nested", "drop.ts"), "const drop = 1\n"),
      writeFile(path.join(directory, "src", "nested", "keep.ts"), "const keep = 1\n"),
      writeFile(path.join(directory, "src", ".hidden.ts"), "const hidden = 1\n"),
      writeFile(path.join(directory, "src", ".hidden", "inside.ts"), "const hidden = 1\n"),
    ])

    const normal = await discoverFiles(request(directory))
    expect(normal.paths).toEqual(["src/[id].ts", "src/main.ts", "src/module.cts", "src/nested/keep.ts"])

    const override = await discoverFiles(request(directory, {
      include: ["src/generated/keep.ts", "src/.hidden.ts"],
      allowIgnoredFiles: true,
    }))
    expect(override.paths).toEqual(["src/.hidden.ts", "src/generated/keep.ts"])

    const literal = await discoverFiles(request(directory, { scopes: ["src/[id].ts"] }))
    expect(literal.paths).toEqual(["src/[id].ts"])

    const ignoredLiteral = await discoverFiles(request(directory, { scopes: ["src/generated/keep.ts"] }))
    expect(ignoredLiteral.paths).toEqual(["src/generated/keep.ts"])
  })

  it.skipIf(process.platform === "win32")("does not follow symlinked ignore files", async () => {
    const directory = await fixture()
    const outside = await fixture()
    await mkdir(path.join(directory, "src"))
    await writeFile(path.join(directory, "src", "main.ts"), "const main = 1\n")
    await writeFile(path.join(outside, "ignore"), "*.ts\n")
    await symlink(path.join(outside, "ignore"), path.join(directory, ".gitignore"))

    const result = await discoverFiles(request(directory))
    expect(result.paths).toEqual(["src/main.ts"])
  })

  it("deduplicates overlapping scopes and applies include and exclude filters", async () => {
    const directory = await fixture()
    await mkdir(path.join(directory, "src"))
    await Promise.all([
      writeFile(path.join(directory, "src", "a.ts"), "const a = 1\n"),
      writeFile(path.join(directory, "src", "b.ts"), "const b = 1\n"),
      writeFile(path.join(directory, "src", "c.ts"), "const c = 1\n"),
    ])

    const result = await discoverFiles(request(directory, {
      scopes: ["src", "src/a.ts"],
      include: ["src/*.ts"],
      exclude: ["b.ts"],
    }))

    expect(result.paths).toEqual(["src/a.ts", "src/c.ts"])

    const excludedScope = await discoverFiles(request(directory, { scopes: ["src"], exclude: ["src"] }))
    expect(excludedScope.paths).toEqual([])
  })
})
