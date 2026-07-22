import path from "node:path"
import { randomBytes } from "node:crypto"
import { chmod, open, rename, unlink } from "node:fs/promises"
import { AstToolError } from "../errors.js"
import { sha256 } from "../hash.js"
import type { PlannedFile, StoredPlan } from "../types.js"
import { loadFile } from "./scope.js"

type StagedFile = { file: PlannedFile; temporaryPath: string }

async function remove(pathname: string): Promise<void> {
  try {
    await unlink(pathname)
  } catch {}
}

async function stage(file: PlannedFile, bytes: Buffer): Promise<string> {
  const temporaryPath = path.join(
    path.dirname(file.realPath),
    `.${path.basename(file.realPath)}.opencode-ast-${randomBytes(8).toString("hex")}.tmp`,
  )
  let handle
  try {
    handle = await open(temporaryPath, "wx", 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    await chmod(temporaryPath, file.mode & 0o7777)
    return temporaryPath
  } catch (error) {
    await handle?.close().catch(() => {})
    await remove(temporaryPath)
    throw error
  }
}

async function validateOriginals(plan: StoredPlan): Promise<void> {
  for (const file of plan.files) {
    const current = await loadFile(plan.realWorktree, file.relativePath)
    if (
      current.realPath !== file.realPath ||
      sha256(current.bytes) !== file.beforeSha256 ||
      current.mode !== file.mode
    ) {
      throw new AstToolError("STALE_PLAN", `file changed after preview: ${file.relativePath}`)
    }
  }
}

async function rollback(files: PlannedFile[], realWorktree: string): Promise<string[]> {
  const failed: string[] = []
  for (const file of [...files].reverse()) {
    let temporaryPath: string | undefined
    try {
      const current = await loadFile(realWorktree, file.relativePath)
      if (
        current.realPath !== file.realPath ||
        sha256(current.bytes) !== file.afterSha256 ||
        current.mode !== file.mode
      ) {
        throw new Error("committed file changed before rollback")
      }
      temporaryPath = await stage(file, file.before)
      await rename(temporaryPath, file.realPath)
      temporaryPath = undefined
    } catch {
      failed.push(file.relativePath)
    } finally {
      if (temporaryPath) await remove(temporaryPath)
    }
  }
  return failed
}

export async function commitPlan(plan: StoredPlan): Promise<void> {
  await validateOriginals(plan)
  const staged: StagedFile[] = []
  try {
    for (const file of plan.files) staged.push({ file, temporaryPath: await stage(file, file.after) })
  } catch (error) {
    await Promise.all(staged.map(({ temporaryPath }) => remove(temporaryPath)))
    throw new AstToolError("STAGING_FAILED", "could not stage all output files", { cause: error })
  }

  try {
    await validateOriginals(plan)
  } catch (error) {
    await Promise.all(staged.map(({ temporaryPath }) => remove(temporaryPath)))
    throw error
  }

  const committed: PlannedFile[] = []
  try {
    for (const item of staged) {
      await rename(item.temporaryPath, item.file.realPath)
      committed.push(item.file)
    }
  } catch (error) {
    await Promise.all(staged.slice(committed.length).map(({ temporaryPath }) => remove(temporaryPath)))
    const rollbackFailed = await rollback(committed, plan.realWorktree)
    const detail = rollbackFailed.length === 0
      ? "committed files were rolled back best-effort"
      : `rollback failed for: ${rollbackFailed.join(", ")}`
    throw new AstToolError("COMMIT_PARTIAL", `commit failed after ${committed.length} file(s); ${detail}`, { cause: error })
  }
}
