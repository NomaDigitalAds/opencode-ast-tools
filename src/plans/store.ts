import { randomBytes } from "node:crypto"
import { HARD_LIMITS } from "../constants.js"
import { AstToolError } from "../errors.js"
import type { PlannedFile, StoredPlan } from "../types.js"

type PlanIdentity = {
  sessionId: string
  realWorktree: string
  pluginVersion: string
  engineVersion: string
}

export class PlanStore {
  private readonly plans = new Map<string, StoredPlan>()
  private readonly claimed = new Set<string>()
  private bytes = 0

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  create(identity: PlanIdentity, files: PlannedFile[]): StoredPlan {
    this.removeExpired()
    const size = this.sizeOfFiles(files)
    if (size > HARD_LIMITS.planStoreBytes) {
      throw new AstToolError("LIMIT_EXCEEDED", "plan exceeds the 64 MiB in-memory store limit")
    }
    while (this.plans.size >= HARD_LIMITS.plans || this.bytes + size > HARD_LIMITS.planStoreBytes) {
      const oldest = [...this.plans.keys()].find((id) => !this.claimed.has(id))
      if (!oldest) break
      this.delete(oldest)
    }
    if (this.plans.size >= HARD_LIMITS.plans || this.bytes + size > HARD_LIMITS.planStoreBytes) {
      throw new AstToolError("LIMIT_EXCEEDED", "plan store is full while plans are being applied")
    }
    const createdAt = this.now()
    const plan: StoredPlan = {
      id: randomBytes(16).toString("hex"),
      ...identity,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      files,
    }
    this.plans.set(plan.id, plan)
    this.bytes += size
    return plan
  }

  get(id: string, identity: PlanIdentity): StoredPlan {
    const plan = this.plans.get(id)
    if (!plan) throw new AstToolError("PLAN_NOT_FOUND", `plan not found: ${id}`)
    if (this.claimed.has(id)) throw new AstToolError("PLAN_NOT_FOUND", `plan is already being applied: ${id}`)
    if (plan.expiresAt <= this.now()) {
      this.delete(id)
      throw new AstToolError("PLAN_EXPIRED", `plan expired: ${id}`)
    }
    if (plan.sessionId !== identity.sessionId || plan.realWorktree !== identity.realWorktree) {
      throw new AstToolError("PLAN_OWNER_MISMATCH", "plan belongs to another session or worktree")
    }
    if (plan.pluginVersion !== identity.pluginVersion || plan.engineVersion !== identity.engineVersion) {
      throw new AstToolError("STALE_PLAN", "plugin or engine version changed after preview")
    }
    this.plans.delete(id)
    this.plans.set(id, plan)
    return plan
  }

  claim(id: string, identity: PlanIdentity): StoredPlan {
    const plan = this.get(id, identity)
    this.claimed.add(id)
    return plan
  }

  release(id: string): void {
    this.claimed.delete(id)
  }

  consume(id: string): void {
    this.delete(id)
  }

  private sizeOfFiles(files: PlannedFile[]): number {
    return files.reduce((total, file) => total + file.before.length + file.after.length, 0)
  }

  private delete(id: string): void {
    const plan = this.plans.get(id)
    if (!plan) return
    this.bytes -= this.sizeOfFiles(plan.files)
    this.plans.delete(id)
    this.claimed.delete(id)
  }

  private removeExpired(): void {
    const now = this.now()
    for (const [id, plan] of this.plans) {
      if (plan.expiresAt <= now && !this.claimed.has(id)) this.delete(id)
    }
  }
}
