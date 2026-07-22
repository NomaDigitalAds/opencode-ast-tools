import path from "node:path"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { createServer } from "node:net"
import { spawn, execFile, type ChildProcess } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createOpencodeClient, type PermissionAction, type PermissionRule, type ToolPart } from "@opencode-ai/sdk/v2"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { startMockOpenAI } from "./support/mock-openai.js"

const execFileAsync = promisify(execFile)
const smoke = process.env.OPENCODE_SMOKE === "1"
const require = createRequire(import.meta.url)
const model = { providerID: "ci-mock", id: "mock-model" }
const promptModel = { providerID: model.providerID, modelID: model.id }
const originalSource = "const value = 1\nconsole.log(value)\n"
const rewrittenSource = "const value = 1\nlogger.info(value)\n"

let root = ""
let project = ""
let sourcePath = ""
let opencode: ChildProcess | undefined
let serverOutput = ""
let mock: Awaited<ReturnType<typeof startMockOpenAI>> | undefined

function permissions(read: PermissionAction, edit: PermissionAction): PermissionRule[] {
  return [
    { permission: "read", pattern: "*", action: read },
    { permission: "edit", pattern: "*", action: edit },
  ]
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("could not allocate a port")
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000
  let diagnostic = "no response"
  while (Date.now() < deadline) {
    if (opencode?.exitCode !== null) throw new Error(`OpenCode exited during startup\n${serverOutput}`)
    try {
      const response = await fetch(`${baseUrl}/global/health`)
      if (response.ok) return
      diagnostic = `HTTP ${response.status}: ${await response.text()}`
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`OpenCode did not become healthy (${diagnostic})\n${serverOutput}`)
}

async function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  if (process.platform === "win32" && child.pid) {
    const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe")
    await execFileAsync(taskkill, ["/pid", String(child.pid), "/t", "/f"]).catch(() => child.kill())
  } else if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM")
    } catch {
      child.kill()
    }
  }
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ])
  if (stopped) return
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {
      child.kill("SIGKILL")
    }
  } else {
    child.kill("SIGKILL")
  }
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))])
}

function toolParts(messages: Array<{ parts: unknown[] }>): ToolPart[] {
  return messages.flatMap((message) => message.parts).filter((part): part is ToolPart => {
    return Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "tool")
  })
}

async function smokeDiagnostics(): Promise<string> {
  try {
    const log = await readFile(path.join(root, "home", ".local", "share", "opencode", "log", "opencode.log"), "utf8")
    return `OpenCode log:\n${log.slice(-16 * 1024)}`
  } catch {
    return "OpenCode log was not created"
  }
}

function isolatedEnvironment(home: string, configDirectory: string, config: object): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const name of [
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
    "PATH",
    "LANG",
    "LC_ALL",
    "CI",
    "GITHUB_ACTIONS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
  ]) {
    const value = process.env[name]
    if (value !== undefined) environment[name] = value
  }
  return {
    ...environment,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    TEMP: path.join(home, "tmp"),
    TMP: path.join(home, "tmp"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    NO_PROXY: "127.0.0.1,localhost",
    OPENCODE_TEST_HOME: home,
    OPENCODE_CONFIG_DIR: configDirectory,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
  }
}

describe.runIf(smoke)("OpenCode package smoke", () => {
  let client: ReturnType<typeof createOpencodeClient>

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "opencode-ast-tools-smoke-"))
    project = path.join(root, "project")
    await mkdir(path.join(project, "src"), { recursive: true })
    project = await realpath(project)
    sourcePath = path.join(project, "src", "main.ts")
    await writeFile(sourcePath, originalSource)
    await execFileAsync("git", ["init", "--quiet"], { cwd: project, timeout: 30_000 })

    mock = await startMockOpenAI({
      async beforeApply(scenario) {
        if (scenario === "SMOKE_STALE") await writeFile(sourcePath, "const value = 2\nconsole.log(value)\n")
      },
    })

    const npmCli = process.env.npm_execpath
    if (!npmCli) throw new Error("npm_execpath is required to pack the smoke artifact")
    const packed = await execFileAsync(process.execPath, [npmCli, "pack", "--json", "--pack-destination", project], {
      cwd: process.cwd(),
      timeout: 120_000,
    })
    console.log("[opencode-smoke] packed npm artifact")
    const packageName = (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0]?.filename
    if (!packageName) throw new Error("npm pack did not return a package filename")

    const home = path.join(root, "home")
    const configDirectory = path.join(home, ".config", "opencode")
    await Promise.all([mkdir(configDirectory, { recursive: true }), mkdir(path.join(home, "tmp"), { recursive: true })])
    await execFileAsync(
      process.execPath,
      [
        npmCli,
        "install",
        "--prefix",
        configDirectory,
        "--ignore-scripts",
        "--offline",
        "--no-audit",
        "--no-fund",
        path.join(project, packageName),
        "@ai-sdk/openai-compatible@3.0.14",
      ],
      { cwd: project, timeout: 60_000 },
    )
    console.log("[opencode-smoke] installed isolated dependencies")
    const pluginEntry = pathToFileURL(
      path.join(configDirectory, "node_modules", "opencode-ast-tools", "dist", "plugin.js"),
    ).href
    const config = {
      $schema: "https://opencode.ai/config.json",
      logLevel: "DEBUG",
      autoupdate: false,
      share: "disabled",
      formatter: false,
      lsp: false,
      model: "ci-mock/mock-model",
      small_model: "ci-mock/mock-model",
      enabled_providers: ["ci-mock"],
      permission: "allow",
      provider: {
        "ci-mock": {
          npm: "@ai-sdk/openai-compatible",
          name: "CI mock",
          options: { baseURL: mock.baseUrl, apiKey: "ci-no-secret" },
          models: {
            "mock-model": {
              name: "CI mock model",
              tool_call: true,
              limit: { context: 32_768, output: 4_096 },
            },
          },
        },
      },
      plugin: [pluginEntry],
    }
    const port = await freePort()
    const packagePath = require.resolve("opencode-ai/package.json")
    const executable = path.join(path.dirname(packagePath), "bin", "opencode.exe")
    const environment = isolatedEnvironment(home, configDirectory, config)
    opencode = spawn(executable, ["serve", "--hostname=127.0.0.1", `--port=${port}`], {
      cwd: project,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const appendOutput = (chunk: Buffer) => {
      serverOutput = (serverOutput + chunk.toString("utf8")).slice(-64 * 1024)
    }
    opencode.stdout?.on("data", appendOutput)
    opencode.stderr?.on("data", appendOutput)

    const baseUrl = `http://127.0.0.1:${port}`
    await waitForHealth(baseUrl)
    console.log("[opencode-smoke] OpenCode server is healthy")
    client = createOpencodeClient({ baseUrl, directory: await realpath(project) })
  }, 180_000)

  afterAll(async () => {
    await stopProcess(opencode)
    await mock?.close()
    if (root) await rm(root, { recursive: true, force: true })
  })

  async function runScenario(marker: string, rules: PermissionRule[], reply?: "once" | "reject") {
    const created = await client.session.create(
      { directory: project, title: marker, model, permission: rules },
      { throwOnError: true },
    )
    if (!created.data) throw new Error(`OpenCode did not create ${marker} session`)
    const sessionID = created.data.id
    const prompt = client.session.prompt(
      {
        sessionID,
        directory: project,
        model: promptModel,
        parts: [{ type: "text", text: marker }],
      },
      { throwOnError: true },
    )
    if (reply) {
      const deadline = Date.now() + 30_000
      let requestID = ""
      while (Date.now() < deadline && !requestID) {
        const pending = await client.permission.list({ directory: project }, { throwOnError: true })
        requestID = pending.data?.find(
          (request) => request.sessionID === sessionID && request.permission === "edit",
        )?.id ?? ""
        if (!requestID) await new Promise((resolve) => setTimeout(resolve, 100))
      }
      if (!requestID) throw new Error(`OpenCode did not request edit permission for ${marker}`)
      await client.permission.reply({ requestID, directory: project, reply }, { throwOnError: true })
    }
    await prompt
    const response = await client.session.messages({ sessionID, directory: project }, { throwOnError: true })
    const parts = toolParts(response.data ?? [])
    if (parts.length === 0) {
      throw new Error(
        `OpenCode produced no tool parts for ${marker}\n${JSON.stringify(response.data).slice(0, 16_384)}\n${serverOutput}`,
      )
    }
    return parts
  }

  it("loads all three tools from the packed npm artifact", async () => {
    const ids = await client.tool.ids({ directory: project }, { throwOnError: true })
    const expected = ["ast_grep_search", "ast_grep_replace", "ast_grep_apply"]
    if (!expected.every((tool) => ids.data?.includes(tool))) {
      throw new Error(
        `Packed plugin tools are missing: ${JSON.stringify(ids.data)}\n${serverOutput}\n${await smokeDiagnostics()}`,
      )
    }
  }, 180_000)

  it("searches and previews without modifying files", async () => {
    await writeFile(sourcePath, originalSource)
    const search = await runScenario("SMOKE_SEARCH", permissions("allow", "deny"))
    expect(search.find((part) => part.tool === "ast_grep_search")?.state.status).toBe("completed")
    expect(await readFile(sourcePath, "utf8")).toBe(originalSource)

    const preview = await runScenario("SMOKE_PREVIEW", permissions("allow", "deny"))
    expect(preview.find((part) => part.tool === "ast_grep_replace")?.state.status).toBe("completed")
    expect(await readFile(sourcePath, "utf8")).toBe(originalSource)
  }, 60_000)

  it("honors read and edit denial without writing", async () => {
    await writeFile(sourcePath, originalSource)
    const readDenied = await runScenario("SMOKE_READ_DENY", permissions("deny", "deny"))
    const deniedSearch = readDenied.find((part) => part.tool === "ast_grep_search")
    expect(deniedSearch?.state.status).toBe("error")
    if (deniedSearch?.state.status === "error") expect(deniedSearch.state.error).toMatch(/permission|denied|rejected/i)
    expect(await readFile(sourcePath, "utf8")).toBe(originalSource)

    const editDenied = await runScenario("SMOKE_EDIT_DENY", permissions("allow", "deny"))
    const deniedApply = editDenied.find((part) => part.tool === "ast_grep_apply")
    expect(deniedApply?.state.status).toBe("error")
    if (deniedApply?.state.status === "error") expect(deniedApply.state.error).toMatch(/permission|denied|rejected/i)
    expect(await readFile(sourcePath, "utf8")).toBe(originalSource)

    const rejectedAsk = await runScenario("SMOKE_ASK_REJECT", permissions("allow", "ask"), "reject")
    const rejectedApply = rejectedAsk.find((part) => part.tool === "ast_grep_apply")
    expect(rejectedApply?.state.status).toBe("error")
    if (rejectedApply?.state.status === "error") expect(rejectedApply.state.error).toMatch(/permission|denied|rejected/i)
    expect(await readFile(sourcePath, "utf8")).toBe(originalSource)
  }, 60_000)

  it("applies an allowed plan and an approved ask", async () => {
    await writeFile(sourcePath, originalSource)
    const allowed = await runScenario("SMOKE_APPLY", permissions("allow", "allow"))
    expect(allowed.find((part) => part.tool === "ast_grep_apply")?.state.status).toBe("completed")
    expect(await readFile(sourcePath, "utf8")).toBe(rewrittenSource)

    await writeFile(sourcePath, originalSource)
    const asked = await runScenario("SMOKE_ASK", permissions("allow", "ask"), "once")
    expect(asked.find((part) => part.tool === "ast_grep_apply")?.state.status).toBe("completed")
    expect(await readFile(sourcePath, "utf8")).toBe(rewrittenSource)
  }, 60_000)

  it("rejects a stale plan without overwriting the changed file", async () => {
    await writeFile(sourcePath, originalSource)
    const stale = await runScenario("SMOKE_STALE", permissions("allow", "allow"))
    const apply = stale.find((part) => part.tool === "ast_grep_apply")
    expect(apply?.state.status).toBe("error")
    if (apply?.state.status === "error") expect(apply.state.error).toContain("STALE_PLAN")
    expect(await readFile(sourcePath, "utf8")).toBe("const value = 2\nconsole.log(value)\n")
  }, 60_000)
})
