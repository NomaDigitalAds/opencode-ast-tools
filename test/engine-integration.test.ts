import path from "node:path"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ENGINE_VERSION, LANGUAGES } from "../src/constants.js"
import { resolveEngine, runEngine, type Engine } from "../src/engine/cli.js"
import { discoverFiles } from "../src/filesystem/discovery.js"
import type { Language } from "../src/types.js"

type Fixture = { extension: string; source: string; pattern: string; replacement: string }

const fixtures: Record<Language, Fixture> = {
  bash: { extension: "sh", source: "echo hello\n", pattern: "echo hello", replacement: "echo goodbye" },
  c: { extension: "c", source: "int main(void) { foo(1); }\n", pattern: "foo(1)", replacement: "bar(1)" },
  cpp: { extension: "cpp", source: "int main() { foo(1); }\n", pattern: "foo(1)", replacement: "bar(1)" },
  csharp: { extension: "cs", source: "class C { void M() { Foo(1); } }\n", pattern: "Foo(1)", replacement: "Bar(1)" },
  css: {
    extension: "css",
    source: ".a { color: red; }\n",
    pattern: ".a { color: red; }",
    replacement: ".a { color: blue; }",
  },
  elixir: { extension: "ex", source: "foo(1)\n", pattern: "foo(1)", replacement: "bar(1)" },
  go: { extension: "go", source: "package main\nfunc main() { foo(1) }\n", pattern: "foo(1)", replacement: "bar(1)" },
  haskell: { extension: "hs", source: "main = print 1\n", pattern: "print 1", replacement: "print 2" },
  html: { extension: "html", source: "<div>one</div>\n", pattern: "<div>one</div>", replacement: "<div>two</div>" },
  java: { extension: "java", source: "class C { void m() { foo(1); } }\n", pattern: "foo(1)", replacement: "bar(1)" },
  javascript: { extension: "js", source: "console.log(value)\n", pattern: "console.log($ARG)", replacement: "logger.info($ARG)" },
  json: { extension: "json", source: "{\"value\": 1}\n", pattern: "{\"value\": 1}", replacement: "{\"value\": 2}" },
  kotlin: { extension: "kt", source: "fun main() { println(1) }\n", pattern: "println(1)", replacement: "println(2)" },
  lua: { extension: "lua", source: "foo(1)\n", pattern: "foo(1)", replacement: "bar(1)" },
  nix: { extension: "nix", source: "{ value = 1; }\n", pattern: "{ value = 1; }", replacement: "{ value = 2; }" },
  php: { extension: "php", source: "<?php foo(1);\n", pattern: "foo(1)", replacement: "bar(1)" },
  python: { extension: "py", source: "print(value)\n", pattern: "print($ARG)", replacement: "logger.info($ARG)" },
  ruby: { extension: "rb", source: "puts(1)\n", pattern: "puts(1)", replacement: "puts(2)" },
  rust: { extension: "rs", source: "fn main() { foo(1); }\n", pattern: "foo(1)", replacement: "bar(1)" },
  scala: { extension: "scala", source: "object Main { def main() = println(1) }\n", pattern: "println(1)", replacement: "println(2)" },
  solidity: {
    extension: "sol",
    source: "contract C { function f() public { foo(1); } }\n",
    pattern: "contract C { function f() public { foo(1); } }",
    replacement: "contract C { function f() public { bar(1); } }",
  },
  swift: { extension: "swift", source: "func f() { foo(1) }\n", pattern: "foo(1)", replacement: "bar(1)" },
  typescript: { extension: "ts", source: "console.log(value)\n", pattern: "console.log($ARG)", replacement: "logger.info($ARG)" },
  tsx: { extension: "tsx", source: "const App = () => <div />\nconsole.log(value)\n", pattern: "console.log($ARG)", replacement: "logger.info($ARG)" },
  yaml: { extension: "yaml", source: "value: 1\n", pattern: "value: 1", replacement: "value: 2" },
}

const integration = process.env.AST_GREP_INTEGRATION === "1"
let directory = ""

describe.runIf(integration)("ast-grep language matrix", () => {
  let engine: Engine

  beforeAll(async () => {
    engine = resolveEngine(ENGINE_VERSION)
    directory = await mkdtemp(path.join(tmpdir(), "opencode-ast-tools-engine-"))
    directory = await realpath(directory)
    await Promise.all(
      LANGUAGES.map(async (language) => {
        const fixture = fixtures[language]
        await writeFile(path.join(directory, `${language}.${fixture.extension}`), fixture.source)
      }),
    )
    await mkdir(path.join(directory, "discovery"))
    await Promise.all([
      writeFile(path.join(directory, ".gitignore"), "discovery/ignored.ts\n"),
      writeFile(path.join(directory, "discovery", "[id].ts"), "console.log(id)\n"),
      writeFile(path.join(directory, "discovery", "ignored.ts"), "console.log(ignored)\n"),
      writeFile(path.join(directory, "discovery", ".hidden.ts"), "console.log(hidden)\n"),
    ])
  })

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  for (const language of LANGUAGES) {
    it(`${language} supports search and rewrite`, async () => {
      const fixture = fixtures[language]
      const common = {
        pattern: fixture.pattern,
        language,
        paths: [`${language}.${fixture.extension}`],
        include: [],
        exclude: [],
        contextLines: 0,
        respectGitignore: true,
        allowIgnoredFiles: false,
        timeoutMs: 15_000,
        signal: new AbortController().signal,
        cwd: directory,
      }
      const search = await runEngine(engine, common)
      const rewrite = await runEngine(engine, { ...common, replacement: fixture.replacement })
      expect(search.matches.length).toBeGreaterThan(0)
      expect(rewrite.matches.some((match) => match.replacement !== undefined)).toBe(true)
    }, 30_000)
  }

  it("honors timeout and abort while the native process is running", async () => {
    const request = {
      pattern: "console.log($ARG)",
      language: "typescript" as const,
      paths: ["typescript.ts"],
      include: [],
      exclude: [],
      contextLines: 0,
      respectGitignore: true,
      allowIgnoredFiles: false,
      cwd: directory,
    }
    await expect(
      runEngine(engine, {
        ...request,
        timeoutMs: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "ENGINE_TIMEOUT" })

    const controller = new AbortController()
    const aborted = runEngine(engine, { ...request, timeoutMs: 15_000, signal: controller.signal })
    setTimeout(() => controller.abort(), 1)
    await expect(aborted).rejects.toMatchObject({ code: "ABORTED" })
  }, 30_000)

  it("processes literal and ignore-override files from a preselected manifest", async () => {
    const common = {
      realWorktree: directory,
      language: "typescript" as const,
      exclude: [],
      respectGitignore: true,
      signal: new AbortController().signal,
      deadline: Date.now() + 30_000,
    }
    const literal = await discoverFiles({
      ...common,
      scopes: ["discovery/[id].ts"],
      include: [],
      allowIgnoredFiles: false,
    })
    const override = await discoverFiles({
      ...common,
      scopes: ["discovery"],
      include: ["discovery/ignored.ts", "discovery/.hidden.ts"],
      allowIgnoredFiles: true,
    })
    const paths = [...literal.paths, ...override.paths]
    const result = await runEngine(engine, {
      pattern: "console.log($ARG)",
      language: "typescript",
      paths,
      include: ["this glob is intentionally ignored for a preselected manifest"],
      exclude: ["**/*.ts"],
      contextLines: 0,
      respectGitignore: true,
      allowIgnoredFiles: false,
      timeoutMs: 30_000,
      signal: common.signal,
      cwd: directory,
      preselectedPaths: true,
    })

    expect(result.matches.map((match) => match.file.replaceAll("\\", "/")).sort()).toEqual([...paths].sort())
  }, 30_000)

  it("runs a large explicit manifest in multiple bounded commands", async () => {
    const result = await runEngine(engine, {
      pattern: "definitely_missing_identifier",
      language: "typescript",
      paths: Array.from({ length: 2_500 }, () => "typescript.ts"),
      include: [],
      exclude: [],
      contextLines: 0,
      respectGitignore: true,
      allowIgnoredFiles: false,
      timeoutMs: 30_000,
      signal: new AbortController().signal,
      cwd: directory,
      preselectedPaths: true,
    })
    expect(result.matches).toEqual([])
  }, 30_000)
})
