import path from "node:path"
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises"
import ignore, { type Ignore } from "ignore"
import { minimatch } from "minimatch"
import { ENGINE_VERSION, HARD_LIMITS } from "../constants.js"
import { AstToolError } from "../errors.js"
import type { Language } from "../types.js"
import { isPathInside } from "./scope.js"

export type DiscoveryResult = {
  paths: string[]
  files: number
  limit: number
  truncated: boolean
}

export type DiscoveryRequest = {
  realWorktree: string
  scopes: string[]
  language: Language
  include: string[]
  exclude: string[]
  respectGitignore: boolean
  allowIgnoredFiles: boolean
  signal: AbortSignal
  deadline: number
}

type IgnoreContext = {
  base: string
  matcher: Ignore
}

// Copied from ast-grep 0.44.1's SupportLang extension map.
const LANGUAGE_EXTENSIONS: Record<Language, readonly string[]> = {
  bash: ["bash", "bats", "cgi", "command", "env", "fcgi", "ksh", "sh", "tmux", "tool", "zsh"],
  c: ["c", "h"],
  cpp: ["cc", "hpp", "cpp", "c++", "hh", "cxx", "cu", "ino"],
  csharp: ["cs"],
  css: ["css", "scss"],
  elixir: ["ex", "exs"],
  go: ["go"],
  haskell: ["hs"],
  html: ["html", "htm", "xhtml"],
  java: ["java"],
  javascript: ["cjs", "js", "mjs", "jsx"],
  json: ["json"],
  kotlin: ["kt", "ktm", "kts"],
  lua: ["lua"],
  nix: ["nix"],
  php: ["php"],
  python: ["py", "py3", "pyi", "bzl", "bazel"],
  ruby: ["rb", "rbw", "gemspec"],
  rust: ["rs"],
  scala: ["scala", "sc", "sbt"],
  solidity: ["sol"],
  swift: ["swift"],
  typescript: ["ts", "cts", "mts"],
  tsx: ["tsx"],
  yaml: ["yaml", "yml"],
}

if (ENGINE_VERSION !== "0.44.1") {
  throw new Error("update the discovery extension map for the pinned ast-grep version")
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function nodeErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined
}

function checkOperation(request: DiscoveryRequest): void {
  if (request.signal.aborted) throw new AstToolError("ABORTED", "operation was aborted")
  if (Date.now() > request.deadline) throw new AstToolError("ENGINE_TIMEOUT", "file discovery timed out")
}

async function withinDeadline<T>(
  request: DiscoveryRequest,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  checkOperation(request)
  const remaining = Math.max(1, request.deadline - Date.now())
  return await new Promise<T>((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout
    const controller = new AbortController()
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.signal.removeEventListener("abort", onAbort)
      callback()
    }
    const onAbort = () => {
      controller.abort()
      finish(() => reject(new AstToolError("ABORTED", "operation was aborted")))
    }
    timer = setTimeout(
      () => {
        controller.abort()
        finish(() => reject(new AstToolError("ENGINE_TIMEOUT", "file discovery timed out")))
      },
      remaining,
    )
    request.signal.addEventListener("abort", onAbort, { once: true })
    if (request.signal.aborted) onAbort()
    if (!settled) {
      try {
        operation(controller.signal).then(
          (value) => finish(() => resolve(value)),
          (error: unknown) => finish(() => reject(error)),
        )
      } catch (error) {
        finish(() => reject(error))
      }
    }
  })
}

function isExcluded(relativePath: string, exclude: string[]): boolean {
  const options = { dot: true, matchBase: true, nocase: process.platform === "win32" }
  let candidate = relativePath
  while (candidate !== ".") {
    if (exclude.some((glob) => minimatch(candidate, glob, options))) return true
    candidate = path.posix.dirname(candidate)
  }
  return false
}

export function matchesGlobs(relativePath: string, include: string[], exclude: string[]): boolean {
  const options = { dot: true, matchBase: true, nocase: process.platform === "win32" }
  if (isExcluded(relativePath, exclude)) return false
  return include.length === 0 || include.some((glob) => minimatch(relativePath, glob, options))
}

function hasLanguageExtension(relativePath: string, language: Language): boolean {
  const extension = path.posix.extname(relativePath).slice(1)
  return LANGUAGE_EXTENSIONS[language].includes(extension)
}

function relativeTo(base: string, target: string): string | undefined {
  if (!base) return target
  if (target === base) return ""
  return target.startsWith(`${base}/`) ? target.slice(base.length + 1) : undefined
}

function ignoredBy(contexts: IgnoreContext[], relativePath: string, directory: boolean): boolean {
  let ignored = false
  for (const context of contexts) {
    const candidate = relativeTo(context.base, relativePath)
    if (!candidate) continue
    const result = context.matcher.test(directory ? `${candidate}/` : candidate)
    if (result.ignored) ignored = true
    if (result.unignored) ignored = false
  }
  return ignored
}

async function readIgnoreContents(
  request: DiscoveryRequest,
  relativePath: string,
): Promise<string | undefined> {
  const candidate = path.join(request.realWorktree, ...relativePath.split("/"))
  try {
    const info = await withinDeadline(request, () => lstat(candidate))
    if (info.isSymbolicLink() || !info.isFile()) return undefined
    if (info.size > 1024 * 1024) {
      throw new AstToolError("LIMIT_EXCEEDED", `ignore file exceeds 1 MiB: ${relativePath}`)
    }
    const resolved = await withinDeadline(request, () => realpath(candidate))
    if (!isPathInside(request.realWorktree, resolved)) {
      throw new AstToolError("PATH_OUTSIDE_WORKTREE", `ignore file escapes the worktree: ${relativePath}`)
    }
    const contents = await withinDeadline(request, (signal) => readFile(resolved, { encoding: "utf8", signal }))
    checkOperation(request)
    return contents
  } catch (error) {
    if (error instanceof AstToolError) throw error
    const code = nodeErrorCode(error)
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return undefined
    if (code === "EACCES" || code === "EPERM") {
      throw new AstToolError("PERMISSION_DENIED", `cannot read ignore file: ${relativePath}`, { cause: error })
    }
    throw new AstToolError("FILE_PARSE_ERROR", `cannot read ignore file: ${relativePath}`, { cause: error })
  }
}

async function readIgnoreContext(
  request: DiscoveryRequest,
  base: string,
  name: string,
): Promise<IgnoreContext | undefined> {
  const relativePath = base ? `${base}/${name}` : name
  const contents = await readIgnoreContents(request, relativePath)
  if (contents === undefined) return undefined
  try {
    const matcher = ignore({ ignorecase: process.platform === "win32" }).add(contents)
    checkOperation(request)
    return {
      base,
      matcher,
    }
  } catch (error) {
    if (error instanceof AstToolError) throw error
    throw new AstToolError("FILE_PARSE_ERROR", `cannot parse ignore file: ${relativePath}`, {
      cause: error,
    })
  }
}

async function localIgnoreContexts(request: DiscoveryRequest, base: string): Promise<IgnoreContext[]> {
  const contexts = await Promise.all([
    readIgnoreContext(request, base, ".gitignore"),
    readIgnoreContext(request, base, ".ignore"),
  ])
  return contexts.filter((context): context is IgnoreContext => context !== undefined)
}

async function inheritedIgnoreContexts(request: DiscoveryRequest, scope: string): Promise<IgnoreContext[]> {
  const contexts: IgnoreContext[] = []
  const infoExclude = await readIgnoreContents(request, ".git/info/exclude")
  if (infoExclude !== undefined) {
    contexts.push({ base: "", matcher: ignore({ ignorecase: process.platform === "win32" }).add(infoExclude) })
  }
  const segments = scope === "." ? [] : scope.split("/")
  for (let index = 0; index < segments.length; index += 1) {
    const base = segments.slice(0, index).join("/")
    contexts.push(...await localIgnoreContexts(request, base))
  }
  return contexts
}

function containedByScope(relativePath: string, directory: string): boolean {
  return directory === "." || relativePath === directory || relativePath.startsWith(`${directory}/`)
}

export async function discoverFiles(request: DiscoveryRequest): Promise<DiscoveryResult> {
  const scopeInfo = await Promise.all(request.scopes.map(async (relativePath) => {
    const absolutePath = path.join(request.realWorktree, ...relativePath.split("/"))
    return { relativePath, absolutePath, info: await withinDeadline(request, () => lstat(absolutePath)) }
  }))
  const explicitFiles = scopeInfo
    .filter(({ info }) => info.isFile())
    .map(({ relativePath }) => relativePath)
    .sort(comparePaths)
  const directories = scopeInfo
    .filter(({ info }) => info.isDirectory())
    .map(({ relativePath }) => relativePath)
    .sort(comparePaths)
    .filter((directory, index, all) => !all.slice(0, index).some((parent) => containedByScope(directory, parent)))
  const selected: string[] = []
  const seen = new Set<string>()
  const canOverrideIgnores = request.allowIgnoredFiles && request.include.length > 0

  const addFile = async (relativePath: string, explicit: boolean): Promise<boolean> => {
    checkOperation(request)
    if (seen.has(relativePath) || !hasLanguageExtension(relativePath, request.language)) return false
    if (!matchesGlobs(relativePath, request.include, request.exclude)) return false
    const absolutePath = path.join(request.realWorktree, ...relativePath.split("/"))
    let info
    if (explicit) {
      const resolved = await withinDeadline(request, () => realpath(absolutePath))
      if (!isPathInside(request.realWorktree, resolved)) {
        throw new AstToolError("PATH_OUTSIDE_WORKTREE", `file escapes the worktree: ${relativePath}`)
      }
      info = await withinDeadline(request, () => stat(resolved))
    } else {
      info = await withinDeadline(request, () => lstat(absolutePath))
      if (info.isSymbolicLink()) return false
    }
    if (!info.isFile()) return false
    seen.add(relativePath)
    if (selected.length === HARD_LIMITS.discoveredFiles) return true
    selected.push(relativePath)
    return false
  }

  for (const relativePath of explicitFiles) {
    if (await addFile(relativePath, true)) {
      return { paths: selected, files: selected.length, limit: HARD_LIMITS.discoveredFiles, truncated: true }
    }
  }

  const walk = async (relativeDirectory: string, contexts: IgnoreContext[]): Promise<boolean> => {
    checkOperation(request)
    const absoluteDirectory = path.join(request.realWorktree, ...relativeDirectory.split("/").filter((part) => part !== "."))
    const resolvedDirectory = await withinDeadline(request, () => realpath(absoluteDirectory))
    if (!isPathInside(request.realWorktree, resolvedDirectory)) return false
    const activeContexts = request.respectGitignore
      ? [...contexts, ...await localIgnoreContexts(request, relativeDirectory === "." ? "" : relativeDirectory)]
      : []
    const entries = await withinDeadline(request, () => readdir(resolvedDirectory, { withFileTypes: true }))
    entries.sort((left, right) => comparePaths(left.name, right.name))
    for (const entry of entries) {
      checkOperation(request)
      if (entry.isSymbolicLink()) continue
      const relativePath = relativeDirectory === "." ? entry.name : `${relativeDirectory}/${entry.name}`
      if (entry.isDirectory()) {
        const excluded = isExcluded(relativePath, request.exclude)
        const hidden = request.respectGitignore && entry.name.startsWith(".")
        const ignored = request.respectGitignore && ignoredBy(activeContexts, relativePath, true)
        if (excluded || ((hidden || ignored) && !canOverrideIgnores)) continue
        if (await walk(relativePath, activeContexts)) return true
        continue
      }
      if (!entry.isFile()) continue
      const hidden = request.respectGitignore && entry.name.startsWith(".")
      const ignored = request.respectGitignore && ignoredBy(activeContexts, relativePath, false)
      const includedOverride = canOverrideIgnores && matchesGlobs(relativePath, request.include, request.exclude)
      if ((hidden || ignored) && !includedOverride) continue
      if (await addFile(relativePath, false)) return true
    }
    return false
  }

  for (const directory of directories) {
    if (isExcluded(directory, request.exclude)) continue
    const contexts = request.respectGitignore
      ? await inheritedIgnoreContexts(request, directory)
      : []
    if (await walk(directory, contexts)) {
      return { paths: selected, files: selected.length, limit: HARD_LIMITS.discoveredFiles, truncated: true }
    }
  }
  return { paths: selected, files: selected.length, limit: HARD_LIMITS.discoveredFiles, truncated: false }
}
