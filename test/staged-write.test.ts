import path from "node:path"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it } from "vitest"
import { commitPlan } from "../src/filesystem/staged-write.js"
import { loadFile } from "../src/filesystem/scope.js"
import { sha256 } from "../src/hash.js"
import type { PlannedFile, StoredPlan } from "../src/types.js"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  })))
})

async function fixture(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-ast-staged-write-"))
  directories.push(directory)
  return directory
}

async function plannedFile(realWorktree: string, requestedPath: string): Promise<PlannedFile> {
  const snapshot = await loadFile(realWorktree, requestedPath)
  const after = Buffer.from(snapshot.bytes.toString("utf8").replace(" = 1", " = 2"))
  return {
    ...snapshot,
    before: snapshot.bytes,
    after,
    beforeSha256: sha256(snapshot.bytes),
    afterSha256: sha256(after),
    replacements: 1,
  }
}

async function plan(directory: string, requestedPaths: string[]): Promise<StoredPlan> {
  const realWorktree = await realpath(directory)
  return {
    id: "a".repeat(32),
    sessionId: "session",
    realWorktree,
    createdAt: 0,
    expiresAt: 1,
    pluginVersion: "0.1.0",
    engineVersion: "0.44.1",
    files: await Promise.all(requestedPaths.map((requestedPath) => plannedFile(realWorktree, requestedPath))),
  }
}

async function temporaryFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.includes(".opencode-ast-") && name.endsWith(".tmp"))
}

async function supportsFileSymlinks(directory: string, target: string): Promise<boolean> {
  const probe = path.join(directory, "symlink-probe")
  try {
    await symlink(target, probe, "file")
    await unlink(probe)
    return true
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined
    if (code === "EPERM" || code === "EACCES") return false
    throw error
  }
}

describe("staged writes", () => {
  it.each(["create", "write", "flush", "chmod"] as const)(
    "cleans every temporary file when %s fails during staging",
    async (failedOperation) => {
      const directory = await fixture()
      await writeFile(path.join(directory, "a.ts"), "const a = 1\n")
      await writeFile(path.join(directory, "b.ts"), "const b = 1\n")
      const preview = await plan(directory, ["a.ts", "b.ts"])
      let calls = 0

      await expect(commitPlan(preview, (operation) => {
        if (operation === failedOperation && ++calls === 2) throw new Error(`injected ${operation} failure`)
      })).rejects.toMatchObject({ code: "STAGING_FAILED" })

      expect(await readFile(path.join(directory, "a.ts"), "utf8")).toBe("const a = 1\n")
      expect(await readFile(path.join(directory, "b.ts"), "utf8")).toBe("const b = 1\n")
      expect(await temporaryFiles(directory)).toEqual([])
    },
  )

  it("does not remove a colliding temporary path it did not create", async () => {
    const directory = await fixture()
    const filePath = path.join(directory, "main.ts")
    await writeFile(filePath, "const value = 1\n")
    const preview = await plan(directory, ["main.ts"])
    let sentinelPath = ""

    await expect(commitPlan(preview, async (operation, pathname) => {
      if (operation !== "create") return
      sentinelPath = pathname
      await writeFile(pathname, "sentinel")
    })).rejects.toMatchObject({ code: "STAGING_FAILED" })

    expect(await readFile(filePath, "utf8")).toBe("const value = 1\n")
    expect(await readFile(sentinelPath, "utf8")).toBe("sentinel")
  })

  it("detects a file change after staging and removes temporary files", async () => {
    const directory = await fixture()
    const filePath = path.join(directory, "main.ts")
    await writeFile(filePath, "const value = 1\n")
    const preview = await plan(directory, ["main.ts"])
    let changed = false

    const commit = commitPlan(preview, async (operation) => {
      if (operation === "chmod" && !changed) {
        changed = true
        await writeFile(filePath, "const value = 3\n")
      }
    })
    await expect(commit).rejects.toMatchObject({ code: "STALE_PLAN" })

    expect(await readFile(filePath, "utf8")).toBe("const value = 3\n")
    expect(await temporaryFiles(directory)).toEqual([])
  })

  it("rolls back the first file when the second commit rename fails", async () => {
    const directory = await fixture()
    await writeFile(path.join(directory, "a.ts"), "const a = 1\n")
    await writeFile(path.join(directory, "b.ts"), "const b = 1\n")
    const preview = await plan(directory, ["a.ts", "b.ts"])
    let renames = 0

    const commit = commitPlan(preview, (operation) => {
      if (operation === "rename" && ++renames === 2) throw new Error("injected commit failure")
    })
    await expect(commit).rejects.toMatchObject({ code: "COMMIT_PARTIAL" })
    await expect(commit).rejects.toThrowError(/commit failed after 1 file\(s\); committed files were rolled back best-effort/)

    expect(await readFile(path.join(directory, "a.ts"), "utf8")).toBe("const a = 1\n")
    expect(await readFile(path.join(directory, "b.ts"), "utf8")).toBe("const b = 1\n")
    expect(await temporaryFiles(directory)).toEqual([])
  })

  it("reports files that could not be rolled back", async () => {
    const directory = await fixture()
    await writeFile(path.join(directory, "a.ts"), "const a = 1\n")
    await writeFile(path.join(directory, "b.ts"), "const b = 1\n")
    const preview = await plan(directory, ["a.ts", "b.ts"])
    let renames = 0

    const commit = commitPlan(preview, (operation) => {
      if (operation === "rename" && ++renames >= 2) throw new Error("injected rename failure")
    })
    await expect(commit).rejects.toMatchObject({ code: "COMMIT_PARTIAL" })
    await expect(commit).rejects.toThrowError(/commit failed after 1 file\(s\); rollback failed for: a\.ts/)

    expect(await readFile(path.join(directory, "a.ts"), "utf8")).toBe("const a = 2\n")
    expect(await readFile(path.join(directory, "b.ts"), "utf8")).toBe("const b = 1\n")
    expect(await temporaryFiles(directory)).toEqual([])
  })

  it("reports a first rename failure without claiming a partial commit", async () => {
    const directory = await fixture()
    const filePath = path.join(directory, "main.ts")
    await writeFile(filePath, "const value = 1\n")
    const preview = await plan(directory, ["main.ts"])

    await expect(commitPlan(preview, (operation) => {
      if (operation === "rename") throw new Error("injected rename failure")
    })).rejects.toMatchObject({ code: "COMMIT_FAILED" })

    expect(await readFile(filePath, "utf8")).toBe("const value = 1\n")
    expect(await temporaryFiles(directory)).toEqual([])
  })

  it("rejects staged output whose mode changes before rename", async ({ skip }) => {
    if (process.platform === "win32") skip("Windows does not preserve POSIX mode bits")
    const directory = await fixture()
    const filePath = path.join(directory, "main.ts")
    await writeFile(filePath, "const value = 1\n", { mode: 0o644 })
    const preview = await plan(directory, ["main.ts"])
    const changedMode = preview.files[0]!.mode ^ 0o100
    let changed = false

    await expect(commitPlan(preview, async (operation) => {
      if (operation !== "rename" || changed) return
      changed = true
      const temporaryPath = (await readdir(directory))
        .map((name) => path.join(directory, name))
        .find((pathname) => pathname.includes(".opencode-ast-") && pathname.endsWith(".tmp"))
      if (!temporaryPath) throw new Error("temporary file was not found")
      await chmod(temporaryPath, changedMode)
    })).rejects.toMatchObject({ code: "COMMIT_FAILED" })

    expect(await readFile(filePath, "utf8")).toBe("const value = 1\n")
    expect(await temporaryFiles(directory)).toEqual([])
  })

  it("reports a temporary file that cleanup could not remove", async () => {
    const directory = await fixture()
    const filePath = path.join(directory, "main.ts")
    await writeFile(filePath, "const value = 1\n")
    const preview = await plan(directory, ["main.ts"])

    const commit = commitPlan(preview, (operation) => {
      if (operation === "write") throw new Error("injected write failure")
      if (operation === "remove") throw new Error("injected cleanup failure")
    })
    await expect(commit).rejects.toMatchObject({ code: "STAGING_FAILED" })
    await expect(commit).rejects.toThrowError(/could not clean temporary file/)

    expect(await readFile(filePath, "utf8")).toBe("const value = 1\n")
    expect(await temporaryFiles(directory)).toHaveLength(1)
  })

  it("detects a second target changed after global validation and rolls back", async () => {
    const directory = await fixture()
    const firstPath = path.join(directory, "a.ts")
    const secondPath = path.join(directory, "b.ts")
    await writeFile(firstPath, "const a = 1\n")
    await writeFile(secondPath, "const b = 1\n")
    const preview = await plan(directory, ["a.ts", "b.ts"])
    let renames = 0

    const commit = commitPlan(preview, async (operation) => {
      if (operation === "rename" && ++renames === 2) await writeFile(secondPath, "const b = 3\n")
    })
    await expect(commit).rejects.toMatchObject({ code: "COMMIT_PARTIAL" })

    expect(await readFile(firstPath, "utf8")).toBe("const a = 1\n")
    expect(await readFile(secondPath, "utf8")).toBe("const b = 3\n")
    expect(await temporaryFiles(directory)).toEqual([])
  })

  it("rejects a target replaced by an escaping symlink after staging", async ({ skip }) => {
    const directory = await fixture()
    const outside = await fixture()
    const filePath = path.join(directory, "main.ts")
    const outsidePath = path.join(outside, "outside.ts")
    await writeFile(filePath, "const value = 1\n")
    await writeFile(outsidePath, "const outside = 1\n")
    if (!await supportsFileSymlinks(directory, outsidePath)) skip("file symlinks are not supported")
    const preview = await plan(directory, ["main.ts"])
    let swapped = false

    const commit = commitPlan(preview, async (operation) => {
      if (operation === "chmod" && !swapped) {
        swapped = true
        await unlink(filePath)
        await symlink(outsidePath, filePath, "file")
      }
    })
    await expect(commit).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKTREE" })

    expect(await readFile(outsidePath, "utf8")).toBe("const outside = 1\n")
    expect(await temporaryFiles(directory)).toEqual([])
  })

  it("rejects a staged file replaced by a symlink before rename", async ({ skip }) => {
    const directory = await fixture()
    const outside = await fixture()
    const filePath = path.join(directory, "main.ts")
    const outsidePath = path.join(outside, "outside.ts")
    await writeFile(filePath, "const value = 1\n")
    await writeFile(outsidePath, "const outside = 1\n")
    if (!await supportsFileSymlinks(directory, outsidePath)) skip("file symlinks are not supported")
    const preview = await plan(directory, ["main.ts"])
    let swapped = false

    const commit = commitPlan(preview, async (operation) => {
      if (operation !== "rename" || swapped) return
      swapped = true
      const temporaryPath = (await readdir(directory))
        .map((name) => path.join(directory, name))
        .find((pathname) => pathname.includes(".opencode-ast-") && pathname.endsWith(".tmp"))
      if (!temporaryPath) throw new Error("temporary file was not found")
      await unlink(temporaryPath)
      await symlink(outsidePath, temporaryPath, "file")
    })
    await expect(commit).rejects.toMatchObject({ code: "COMMIT_FAILED" })

    expect(await readFile(filePath, "utf8")).toBe("const value = 1\n")
    expect(await readFile(outsidePath, "utf8")).toBe("const outside = 1\n")
    expect(await temporaryFiles(directory)).toEqual([])
  })

  it("does not stage outside after a canonical parent junction swap", async () => {
    const directory = await fixture()
    const outside = await fixture()
    const actual = path.join(directory, "actual")
    const displaced = path.join(directory, "displaced")
    await mkdir(actual)
    await writeFile(path.join(actual, "main.ts"), "const value = 1\n")
    await writeFile(path.join(outside, "main.ts"), "const outside = 1\n")
    const preview = await plan(directory, ["actual/main.ts"])
    let swapped = false

    await expect(commitPlan(preview, async (operation) => {
      if (operation !== "create" || swapped) return
      swapped = true
      await rename(actual, displaced)
      await symlink(outside, actual, process.platform === "win32" ? "junction" : "dir")
    })).rejects.toMatchObject({ code: "STAGING_FAILED" })

    expect(await readFile(path.join(outside, "main.ts"), "utf8")).toBe("const outside = 1\n")
    expect(await temporaryFiles(outside)).toEqual([])
    expect(await temporaryFiles(displaced)).toEqual([])
  })

  it("keeps a canonical target when its directory junction alias is swapped", async () => {
    const directory = await fixture()
    const outside = await fixture()
    const actual = path.join(directory, "actual")
    const alias = path.join(directory, "alias")
    await mkdir(actual)
    await writeFile(path.join(actual, "main.ts"), "const value = 1\n")
    await writeFile(path.join(outside, "main.ts"), "const outside = 1\n")
    await symlink(actual, alias, process.platform === "win32" ? "junction" : "dir")
    const preview = await plan(directory, ["alias/main.ts"])

    await unlink(alias)
    await symlink(outside, alias, process.platform === "win32" ? "junction" : "dir")
    await commitPlan(preview)

    expect(await readFile(path.join(actual, "main.ts"), "utf8")).toBe("const value = 2\n")
    expect(await readFile(path.join(outside, "main.ts"), "utf8")).toBe("const outside = 1\n")
  })
})
