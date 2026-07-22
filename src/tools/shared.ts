import type { ToolContext } from "@opencode-ai/plugin"

export async function askRead(context: ToolContext, paths: string[], tool: string): Promise<void> {
  await context.ask({
    permission: "read",
    patterns: paths,
    always: ["*"],
    metadata: { tool },
  })
}
