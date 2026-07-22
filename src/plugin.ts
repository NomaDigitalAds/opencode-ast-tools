import type { Plugin } from "@opencode-ai/plugin"
import { ENGINE_VERSION } from "./constants.js"
import { parseConfig } from "./config.js"
import { resolveEngine } from "./engine/cli.js"
import { PlanStore } from "./plans/store.js"
import { createApplyTool } from "./tools/apply.js"
import { createReplaceTool } from "./tools/replace.js"
import { createSearchTool } from "./tools/search.js"

export const AstToolsPlugin: Plugin = async (_input, options) => {
  const config = parseConfig(options)
  const engine = resolveEngine(ENGINE_VERSION)
  const store = new PlanStore(config.limits.planTtlSeconds * 1_000)

  return {
    tool: {
      ast_grep_search: createSearchTool(engine, config),
      ast_grep_replace: createReplaceTool(engine, config, store),
      ast_grep_apply: createApplyTool(engine, store),
    },
  }
}

export default AstToolsPlugin
