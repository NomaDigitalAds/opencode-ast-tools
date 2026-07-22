import { minimatch } from "minimatch"
import type { ToolContext } from "@opencode-ai/plugin"

export function matchesGlobs(path: string, include: string[], exclude: string[]): boolean {
  const options = { dot: true, matchBase: true, nocase: process.platform === "win32" }
  if (exclude.some((glob) => minimatch(path, glob, options))) return false
  return include.length === 0 || include.some((glob) => minimatch(path, glob, options))
}

export async function askRead(context: ToolContext, paths: string[], tool: string): Promise<void> {
  await context.ask({
    permission: "read",
    patterns: paths,
    always: ["*"],
    metadata: { tool },
  })
}
