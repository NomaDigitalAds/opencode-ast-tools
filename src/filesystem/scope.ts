import path from "node:path"
import { constants } from "node:fs"
import { realpath, open, stat } from "node:fs/promises"
import { TextDecoder } from "node:util"
import { HARD_LIMITS } from "../constants.js"
import { AstToolError } from "../errors.js"
import { validateRelativePath } from "../validation.js"

export type FileSnapshot = {
  relativePath: string
  realPath: string
  bytes: Buffer
  mode: number
}

function nodeErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined
}

function pathError(error: unknown, target: string): AstToolError {
  const code = nodeErrorCode(error)
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new AstToolError("PATH_NOT_FOUND", `path not found: ${target}`, { cause: error })
  }
  if (code === "EACCES" || code === "EPERM") {
    return new AstToolError("PERMISSION_DENIED", `permission denied: ${target}`, { cause: error })
  }
  return new AstToolError("PATH_NOT_FOUND", `cannot access path: ${target}`, { cause: error })
}

export function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

export async function resolveWorktree(worktree: string): Promise<string> {
  try {
    const resolved = await realpath(worktree)
    const info = await stat(resolved)
    if (!info.isDirectory()) {
      throw new AstToolError("PATH_NOT_FOUND", "worktree is not a directory")
    }
    return resolved
  } catch (error) {
    if (error instanceof AstToolError) throw error
    throw pathError(error, worktree)
  }
}

export async function validateScopePaths(realWorktree: string, paths: string[]): Promise<string[]> {
  const canonicalPaths: string[] = []
  for (const input of paths) {
    const target = path.resolve(realWorktree, input)
    let resolved: string
    try {
      resolved = await realpath(target)
    } catch (error) {
      throw pathError(error, input)
    }
    if (!isPathInside(realWorktree, resolved)) {
      throw new AstToolError("PATH_OUTSIDE_WORKTREE", `path escapes the worktree: ${input}`)
    }
    const info = await stat(resolved)
    if (!info.isDirectory() && !info.isFile()) {
      throw new AstToolError("INVALID_ARGUMENT", `path must be a regular file or directory: ${input}`)
    }
    const relative = path.relative(realWorktree, resolved)
    canonicalPaths.push(relative === "" ? "." : relative.replaceAll("\\", "/"))
  }
  return [...new Set(canonicalPaths)]
}

export async function loadFile(realWorktree: string, input: string): Promise<FileSnapshot> {
  const requestedPath = validateRelativePath(input).replace(/^\.\//, "")
  const unresolved = path.resolve(realWorktree, requestedPath)
  let realPath: string
  try {
    realPath = await realpath(unresolved)
  } catch (error) {
    throw pathError(error, requestedPath)
  }
  if (!isPathInside(realWorktree, realPath)) {
    throw new AstToolError("PATH_OUTSIDE_WORKTREE", `file escapes the worktree: ${requestedPath}`)
  }
  const relativePath = path.relative(realWorktree, realPath).replaceAll("\\", "/")

  let handle
  try {
    handle = await open(realPath, constants.O_RDONLY | constants.O_NONBLOCK)
    const info = await handle.stat()
    if (!info.isFile()) {
      throw new AstToolError("INVALID_ARGUMENT", `target is not a regular file: ${relativePath}`)
    }
    if (info.size > HARD_LIMITS.fileBytes) {
      throw new AstToolError("LIMIT_EXCEEDED", `file exceeds ${HARD_LIMITS.fileBytes} bytes: ${relativePath}`)
    }
    const chunks: Buffer[] = []
    let total = 0
    while (total <= HARD_LIMITS.fileBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, HARD_LIMITS.fileBytes + 1 - total))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      chunks.push(chunk.subarray(0, bytesRead))
      total += bytesRead
    }
    if (total > HARD_LIMITS.fileBytes) {
      throw new AstToolError("LIMIT_EXCEEDED", `file exceeds ${HARD_LIMITS.fileBytes} bytes: ${relativePath}`)
    }
    const bytes = Buffer.concat(chunks, total)
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch (error) {
      throw new AstToolError("FILE_PARSE_ERROR", `file is not valid UTF-8: ${relativePath}`, { cause: error })
    }
    return { relativePath, realPath, bytes, mode: info.mode }
  } catch (error) {
    if (error instanceof AstToolError) throw error
    throw pathError(error, relativePath)
  } finally {
    await handle?.close()
  }
}
