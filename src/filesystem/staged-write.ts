import path from "node:path"
import { randomBytes } from "node:crypto"
import { lstat, open, rename, unlink } from "node:fs/promises"
import { AstToolError } from "../errors.js"
import { sha256 } from "../hash.js"
import type { PlannedFile, StoredPlan } from "../types.js"
import { loadFile } from "./scope.js"

type StagedFile = { file: PlannedFile; temporaryPath: string }
type WriteOperation = "create" | "write" | "flush" | "chmod" | "rename" | "remove"
type FaultInjector = (operation: WriteOperation, pathname: string) => void | Promise<void>

const noFault: FaultInjector = () => {}

function nodeErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined
}

async function remove(pathname: string, injectFault: FaultInjector): Promise<boolean> {
  for (let attempt = 0; attempt <= 5; attempt += 1) {
    try {
      await injectFault("remove", pathname)
      await unlink(pathname)
      return true
    } catch (error) {
      const code = nodeErrorCode(error)
      if (code === "ENOENT") return true
      if ((code === "EBUSY" || code === "EPERM") && attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
        continue
      }
      return false
    }
  }
  return false
}

async function cleanup(paths: string[], injectFault: FaultInjector): Promise<string[]> {
  const removed = await Promise.all(paths.map((pathname) => remove(pathname, injectFault)))
  return paths.filter((_, index) => !removed[index])
}

async function stage(
  file: PlannedFile,
  bytes: Buffer,
  injectFault: FaultInjector,
  validateTarget: () => Promise<void>,
): Promise<string> {
  const temporaryPath = path.join(
    path.dirname(file.realPath),
    `.${path.basename(file.realPath)}.opencode-ast-${randomBytes(8).toString("hex")}.tmp`,
  )
  let handle
  let ownsTemporaryPath = false
  try {
    await injectFault("create", temporaryPath)
    await validateTarget()
    handle = await open(temporaryPath, "wx", 0o600)
    ownsTemporaryPath = true
    await injectFault("write", temporaryPath)
    await handle.writeFile(bytes)
    await injectFault("flush", temporaryPath)
    await handle.sync()
    await injectFault("chmod", temporaryPath)
    await handle.chmod(file.mode & 0o7777)
    await handle.close()
    handle = undefined
    return temporaryPath
  } catch (error) {
    await handle?.close().catch(() => {})
    if (ownsTemporaryPath && !await remove(temporaryPath, injectFault)) {
      throw new AstToolError("STAGING_FAILED", `could not clean temporary file: ${file.relativePath}`, { cause: error })
    }
    throw error
  }
}

async function validateFile(file: PlannedFile, realWorktree: string, expectedSha256: string): Promise<void> {
  const current = await loadFile(realWorktree, file.relativePath)
  if (
    current.realPath !== file.realPath ||
    sha256(current.bytes) !== expectedSha256 ||
    current.mode !== file.mode
  ) {
    throw new AstToolError("STALE_PLAN", `file changed after preview: ${file.relativePath}`)
  }
}

async function validateOriginals(plan: StoredPlan): Promise<void> {
  for (const file of plan.files) await validateFile(file, plan.realWorktree, file.beforeSha256)
}

async function validateStaged(temporaryPath: string, expectedSha256: string, expectedMode: number): Promise<void> {
  const pathInfo = await lstat(temporaryPath)
  if (!pathInfo.isFile()) throw new Error("staged output is not a regular file")
  const handle = await open(temporaryPath, "r")
  try {
    const info = await handle.stat()
    const bytes = await handle.readFile()
    if (
      !info.isFile() ||
      sha256(bytes) !== expectedSha256 ||
      (info.mode & 0o7777) !== (expectedMode & 0o7777)
    ) {
      throw new Error("staged output changed before commit")
    }
  } finally {
    await handle.close()
  }
}

async function rollback(files: PlannedFile[], realWorktree: string, injectFault: FaultInjector): Promise<string[]> {
  const failed: string[] = []
  for (const file of [...files].reverse()) {
    let temporaryPath: string | undefined
    try {
      await validateFile(file, realWorktree, file.afterSha256)
      temporaryPath = await stage(
        file,
        file.before,
        injectFault,
        () => validateFile(file, realWorktree, file.afterSha256),
      )
      await injectFault("rename", file.realPath)
      await validateFile(file, realWorktree, file.afterSha256)
      await validateStaged(temporaryPath, file.beforeSha256, file.mode)
      await rename(temporaryPath, file.realPath)
      temporaryPath = undefined
    } catch {
      failed.push(file.relativePath)
    } finally {
      if (temporaryPath && !await remove(temporaryPath, injectFault) && !failed.includes(file.relativePath)) {
        failed.push(file.relativePath)
      }
    }
  }
  return failed
}

export async function commitPlan(plan: StoredPlan, injectFault: FaultInjector = noFault): Promise<void> {
  await validateOriginals(plan)
  const staged: StagedFile[] = []
  try {
    for (const file of plan.files) {
      staged.push({
        file,
        temporaryPath: await stage(
          file,
          file.after,
          injectFault,
          () => validateFile(file, plan.realWorktree, file.beforeSha256),
        ),
      })
    }
  } catch (error) {
    const cleanupFailed = await cleanup(staged.map(({ temporaryPath }) => temporaryPath), injectFault)
    if (cleanupFailed.length > 0) {
      throw new AstToolError("STAGING_FAILED", `temporary cleanup failed for ${cleanupFailed.length} file(s)`, { cause: error })
    }
    if (error instanceof AstToolError && error.code === "STAGING_FAILED") throw error
    throw new AstToolError("STAGING_FAILED", "could not stage all output files", { cause: error })
  }

  try {
    await validateOriginals(plan)
  } catch (error) {
    const cleanupFailed = await cleanup(staged.map(({ temporaryPath }) => temporaryPath), injectFault)
    if (cleanupFailed.length > 0) {
      throw new AstToolError("STAGING_FAILED", `stale plan cleanup failed for ${cleanupFailed.length} file(s)`, { cause: error })
    }
    throw error
  }

  const committed: PlannedFile[] = []
  try {
    for (const item of staged) {
      await injectFault("rename", item.file.realPath)
      await validateFile(item.file, plan.realWorktree, item.file.beforeSha256)
      await validateStaged(item.temporaryPath, item.file.afterSha256, item.file.mode)
      await rename(item.temporaryPath, item.file.realPath)
      committed.push(item.file)
    }
  } catch (error) {
    const cleanupFailed = await cleanup(
      staged.slice(committed.length).map(({ temporaryPath }) => temporaryPath),
      injectFault,
    )
    const cleanupDetail = cleanupFailed.length === 0
      ? ""
      : `; temporary cleanup failed for ${cleanupFailed.length} file(s)`
    if (committed.length === 0) {
      throw new AstToolError("COMMIT_FAILED", `commit failed before replacing any files${cleanupDetail}`, { cause: error })
    }
    const rollbackFailed = await rollback(committed, plan.realWorktree, injectFault)
    const detail = rollbackFailed.length === 0
      ? "committed files were rolled back best-effort"
      : `rollback failed for: ${rollbackFailed.join(", ")}`
    throw new AstToolError(
      "COMMIT_PARTIAL",
      `commit failed after ${committed.length} file(s); ${detail}${cleanupDetail}`,
      { cause: error },
    )
  }
}
