import path from "node:path"
import { createRequire } from "node:module"
import { readFileSync, existsSync } from "node:fs"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { HARD_LIMITS } from "../constants.js"
import { AstToolError } from "../errors.js"
import type { Language } from "../types.js"
import { parseEngineJson, type EngineMatch } from "./json.js"

export type Engine = {
  executable: string
  version: string
}

export type EngineRequest = {
  pattern: string
  replacement?: string
  language: Language
  paths: string[]
  include: string[]
  exclude: string[]
  contextLines: number
  respectGitignore: boolean
  allowIgnoredFiles: boolean
  timeoutMs: number
  signal: AbortSignal
  cwd: string
}

export type EngineResult = {
  matches: EngineMatch[]
  warnings: string[]
  outputBytes: number
}

const require = createRequire(import.meta.url)

function platformEnginePackage(): { name: string; binary: string } | undefined {
  const platform = `${process.platform}-${process.arch}`
  const packages: Record<string, { name: string; binary: string }> = {
    "darwin-arm64": { name: "@ast-grep/cli-darwin-arm64", binary: "ast-grep" },
    "darwin-x64": { name: "@ast-grep/cli-darwin-x64", binary: "ast-grep" },
    "linux-arm64": { name: "@ast-grep/cli-linux-arm64-gnu", binary: "ast-grep" },
    "linux-x64": { name: "@ast-grep/cli-linux-x64-gnu", binary: "ast-grep" },
    "win32-arm64": { name: "@ast-grep/cli-win32-arm64-msvc", binary: "ast-grep.exe" },
    "win32-x64": { name: "@ast-grep/cli-win32-x64-msvc", binary: "ast-grep.exe" },
  }
  return packages[platform]
}

export function resolveEngine(expectedVersion: string): Engine {
  let packagePath: string
  try {
    packagePath = require.resolve("@ast-grep/cli/package.json")
  } catch (error) {
    throw new AstToolError("ENGINE_OUTPUT_INVALID", "@ast-grep/cli is not installed", { cause: error })
  }
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown }
  if (packageJson.version !== expectedVersion) {
    throw new AstToolError(
      "ENGINE_OUTPUT_INVALID",
      `expected ast-grep ${expectedVersion}, found ${String(packageJson.version)}`,
    )
  }
  const packageDirectory = path.dirname(packagePath)
  let executable = ""
  const platformPackage = platformEnginePackage()
  if (platformPackage) {
    try {
      const platformPackagePath = require.resolve(`${platformPackage.name}/package.json`, {
        paths: [packageDirectory],
      })
      executable = path.join(path.dirname(platformPackagePath), platformPackage.binary)
    } catch {}
  }
  if (!existsSync(executable)) {
    executable = path.join(packageDirectory, process.platform === "win32" ? "ast-grep.exe" : "ast-grep")
  }
  if (!existsSync(executable)) {
    throw new AstToolError("ENGINE_OUTPUT_INVALID", "the @ast-grep/cli platform executable is missing")
  }
  const probe = spawnSync(executable, ["--version"], {
    env: sanitizedEnvironment(),
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    timeout: 5_000,
  })
  if (probe.error || probe.status !== 0) {
    throw new AstToolError("ENGINE_OUTPUT_INVALID", "could not verify the installed ast-grep executable", {
      cause: probe.error,
    })
  }
  const detectedVersion = probe.stdout.match(/\b(\d+\.\d+\.\d+)\b/)?.[1]
  if (detectedVersion !== expectedVersion) {
    throw new AstToolError(
      "ENGINE_OUTPUT_INVALID",
      `expected ast-grep executable ${expectedVersion}, found ${detectedVersion ?? "an unknown version"}`,
    )
  }
  return { executable, version: expectedVersion }
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG", "LC_ALL"]
  const env: NodeJS.ProcessEnv = { NO_COLOR: "1" }
  for (const name of allowed) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

function terminateProcess(child: ChildProcess): void {
  if (!child.pid || child.killed) return
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
    const taskkill = path.join(systemRoot, "System32", "taskkill.exe")
    const killer = spawn(taskkill, ["/pid", String(child.pid), "/t", "/f"], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    })
    killer.on("error", () => child.kill())
    killer.unref()
    child.kill()
    return
  }
  try {
    process.kill(-child.pid, "SIGKILL")
  } catch {
    child.kill("SIGKILL")
  }
}

function cleanWarning(value: string): string {
  return value
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
}

function buildArguments(request: EngineRequest): string[] {
  const args = [
    "run",
    "--pattern",
    request.pattern,
    "--lang",
    request.language,
    "--json=compact",
    "--color=never",
    "--context",
    String(request.contextLines),
  ]
  if (request.replacement !== undefined) args.push("--rewrite", request.replacement)
  for (const glob of request.exclude) args.push("--globs", `!${glob}`)
  if (request.allowIgnoredFiles) {
    for (const glob of request.include) args.push("--globs", glob)
  }
  if (!request.respectGitignore) {
    for (const kind of ["hidden", "dot", "exclude", "global", "parent", "vcs"]) {
      args.push("--no-ignore", kind)
    }
  }
  args.push("--", ...request.paths)
  return args
}

function engineFailure(stderr: string): AstToolError {
  const message = cleanWarning(stderr) || "ast-grep exited unsuccessfully"
  if (/pattern|parse|meta.?variable/i.test(message)) {
    return new AstToolError("PATTERN_PARSE_ERROR", message)
  }
  return new AstToolError("ENGINE_OUTPUT_INVALID", message)
}

export async function runEngine(engine: Engine, request: EngineRequest): Promise<EngineResult> {
  if (request.signal.aborted) throw new AstToolError("ABORTED", "operation was aborted")

  return await new Promise<EngineResult>((resolve, reject) => {
    const child = spawn(engine.executable, buildArguments(request), {
      cwd: request.cwd,
      env: sanitizedEnvironment(),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let aborted = false
    let timedOut = false
    let outputExceeded = false

    let timer: NodeJS.Timeout | undefined
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      request.signal.removeEventListener("abort", onAbort)
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onAbort = () => {
      aborted = true
      terminateProcess(child)
    }
    timer = setTimeout(() => {
      timedOut = true
      terminateProcess(child)
    }, request.timeoutMs)

    request.signal.addEventListener("abort", onAbort, { once: true })
    if (request.signal.aborted) onAbort()
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > HARD_LIMITS.engineOutputBytes) {
        outputExceeded = true
        terminateProcess(child)
        return
      }
      stdout.push(chunk)
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= 256 * 1024) return
      stderr.push(chunk)
      stderrBytes += chunk.length
    })
    child.on("error", (error) => fail(new AstToolError("ENGINE_OUTPUT_INVALID", error.message, { cause: error })))
    child.on("close", (code) => {
      if (settled) return
      settled = true
      cleanup()
      if (aborted) return reject(new AstToolError("ABORTED", "operation was aborted"))
      if (timedOut) return reject(new AstToolError("ENGINE_TIMEOUT", `ast-grep exceeded ${request.timeoutMs}ms`))
      if (outputExceeded) return reject(new AstToolError("LIMIT_EXCEEDED", "ast-grep stdout exceeded 8 MiB"))

      const output = Buffer.concat(stdout).toString("utf8")
      const errorOutput = Buffer.concat(stderr).toString("utf8")
      if (code !== 0 && code !== 1) return reject(engineFailure(errorOutput))
      try {
        const matches = parseEngineJson(output)
        const warnings = cleanWarning(errorOutput).split(/\r?\n/).filter(Boolean).slice(0, 20)
        resolve({ matches, warnings, outputBytes: stdoutBytes })
      } catch (error) {
        reject(error)
      }
    })
  })
}
