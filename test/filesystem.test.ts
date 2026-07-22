import path from "node:path"
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it } from "vitest"
import { commitPlan } from "../src/filesystem/staged-write.js"
import { loadFile, validateScopePaths } from "../src/filesystem/scope.js"
import { sha256 } from "../src/hash.js"
import type { StoredPlan } from "../src/types.js"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture(): Promise<{ directory: string; filePath: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-ast-tools-"))
  directories.push(directory)
  const filePath = path.join(directory, "main.ts")
  await writeFile(filePath, "const value = 1\r\n")
  return { directory, filePath }
}

async function plan(directory: string, filePath: string): Promise<StoredPlan> {
  const before = await readFile(filePath)
  const after = Buffer.from("const value = 2\r\n")
  const info = await stat(filePath)
  return {
    id: "a".repeat(32),
    sessionId: "session",
    realWorktree: await realpath(directory),
    createdAt: 0,
    expiresAt: 1,
    pluginVersion: "0.1.0",
    engineVersion: "0.44.1",
    files: [{
      relativePath: "main.ts",
      realPath: await realpath(filePath),
      before,
      after,
      beforeSha256: sha256(before),
      afterSha256: sha256(after),
      mode: info.mode,
      replacements: 1,
    }],
  }
}

describe("filesystem safety", () => {
  it("rejects non-UTF-8 files", async () => {
    const { directory, filePath } = await fixture()
    await writeFile(filePath, Buffer.from([0xff, 0xfe]))
    await expect(loadFile(await realpath(directory), "main.ts")).rejects.toThrowError("FILE_PARSE_ERROR")
  })

  it("commits staged bytes while preserving CRLF", async () => {
    const { directory, filePath } = await fixture()
    await commitPlan(await plan(directory, filePath))
    expect(await readFile(filePath, "utf8")).toBe("const value = 2\r\n")
  })

  it("uses canonical paths for scopes and result files", async () => {
    const { directory } = await fixture()
    const actualDirectory = path.join(directory, "actual")
    const aliasDirectory = path.join(directory, "alias")
    await mkdir(actualDirectory)
    await writeFile(path.join(actualDirectory, "value.ts"), "const value = 1\n")
    await symlink(actualDirectory, aliasDirectory, process.platform === "win32" ? "junction" : "dir")

    expect(await validateScopePaths(await realpath(directory), ["alias"])).toEqual(["actual"])
    expect((await loadFile(await realpath(directory), "alias/value.ts")).relativePath).toBe("actual/value.ts")
  })

  it("writes nothing when a plan is stale", async () => {
    const { directory, filePath } = await fixture()
    const preview = await plan(directory, filePath)
    await writeFile(filePath, "const value = 3\r\n")
    await expect(commitPlan(preview)).rejects.toThrowError("STALE_PLAN")
    expect(await readFile(filePath, "utf8")).toBe("const value = 3\r\n")
  })
})
