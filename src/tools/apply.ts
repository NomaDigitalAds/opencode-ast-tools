import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { PLUGIN_VERSION } from "../constants.js"
import type { Engine } from "../engine/cli.js"
import { AstToolError } from "../errors.js"
import { commitPlan } from "../filesystem/staged-write.js"
import { resolveWorktree } from "../filesystem/scope.js"
import { renderApply } from "../output/render.js"
import { PlanStore } from "../plans/store.js"

export function createApplyTool(engine: Engine, store: PlanStore): ToolDefinition {
  return tool({
    description: "Apply exactly one unexpired ast_grep_replace plan after edit permission and staleness checks.",
    args: {
      planId: tool.schema.string().regex(/^[a-f0-9]{32}$/),
    },
    async execute(args, context) {
      const realWorktree = await resolveWorktree(context.worktree)
      const identity = {
        sessionId: context.sessionID,
        realWorktree,
        pluginVersion: PLUGIN_VERSION,
        engineVersion: engine.version,
      }
      const preview = store.get(args.planId, identity)
      const paths = preview.files.map((file) => file.relativePath)
      await context.ask({
        permission: "edit",
        patterns: paths,
        always: ["*"],
        metadata: { planId: preview.id, files: paths },
      })
      const plan = store.claim(args.planId, identity)
      try {
        if (context.abort.aborted) throw new AstToolError("ABORTED", "operation was aborted")
        await commitPlan(plan)
        store.consume(plan.id)
      } catch (error) {
        if (error instanceof AstToolError && error.code === "COMMIT_PARTIAL") store.consume(plan.id)
        else store.release(plan.id)
        throw error
      }
      return {
        title: `ast-grep apply: ${plan.files.length} file(s)`,
        output: renderApply(plan),
        metadata: {
          planId: plan.id,
          files: plan.files.map((file) => ({ path: file.relativePath, sha256: file.afterSha256 })),
        },
      }
    },
  })
}
