import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error("npm_execpath is required")

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
if (!/^0\.1\.0-alpha\.\d+$/.test(packageJson.version)) throw new Error("package version is not a 0.1.0 alpha")
if (packageJson.publishConfig?.tag !== "alpha") throw new Error("package publish tag must be alpha")
if (packageJson.repository?.url !== "git+https://github.com/NomaDigitalAds/opencode-ast-tools.git") {
  throw new Error("package repository does not match the trusted GitHub repository")
}
const packArguments = [npmCli, "pack", "--json"]
if (!process.argv.includes("--pack")) packArguments.push("--dry-run")

const [result] = JSON.parse(execFileSync(process.execPath, packArguments, { encoding: "utf8" }))
if (!result) throw new Error("npm pack returned no package")

const paths = new Set(result.files.map((file) => file.path))
const required = [
  "README.md",
  "ROADMAP.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "dist/plugin.js",
  "dist/plugin.d.ts",
  "package.json",
]
const missing = required.filter((file) => !paths.has(file))
if (missing.length > 0) throw new Error(`package is missing required files: ${missing.join(", ")}`)

const forbidden = [...paths].filter((file) => /^(?:\.github|node_modules|scripts|src|test)\//.test(file))
if (forbidden.length > 0) throw new Error(`package contains private build files: ${forbidden.join(", ")}`)

const expectedFilename = `${packageJson.name}-${packageJson.version}.tgz`
if (result.filename !== expectedFilename) {
  throw new Error(`expected package filename ${expectedFilename}, received ${result.filename}`)
}

console.log(`validated ${result.filename}: ${result.entryCount} files, ${result.unpackedSize} unpacked bytes`)
