import { describe, expect, it } from "vitest"
import { PlanStore } from "../src/plans/store.js"
import type { PlannedFile } from "../src/types.js"

const identity = {
  sessionId: "session-1",
  realWorktree: "/workspace",
  pluginVersion: "0.1.0",
  engineVersion: "0.44.1",
}

const file: PlannedFile = {
  relativePath: "src/main.ts",
  realPath: "/workspace/src/main.ts",
  before: Buffer.from("before"),
  after: Buffer.from("after"),
  beforeSha256: "before-hash",
  afterSha256: "after-hash",
  mode: 0o644,
  replacements: 1,
}

describe("plan store", () => {
  it("binds plans to their session and worktree", () => {
    const store = new PlanStore(1_000)
    const plan = store.create(identity, [file])
    expect(() => store.get(plan.id, { ...identity, sessionId: "session-2" })).toThrowError("PLAN_OWNER_MISMATCH")
    expect(store.get(plan.id, identity)).toBe(plan)
  })

  it("expires plans and makes consumed plans single-use", () => {
    let now = 100
    const store = new PlanStore(10, () => now)
    const expired = store.create(identity, [file])
    now = 111
    expect(() => store.get(expired.id, identity)).toThrowError("PLAN_EXPIRED")

    const active = store.create(identity, [file])
    store.consume(active.id)
    expect(() => store.get(active.id, identity)).toThrowError("PLAN_NOT_FOUND")
  })

  it("allows only one in-flight apply and rechecks expiry when claimed", () => {
    let now = 100
    const store = new PlanStore(10, () => now)
    const active = store.create(identity, [file])
    expect(store.claim(active.id, identity)).toBe(active)
    expect(() => store.get(active.id, identity)).toThrowError("PLAN_NOT_FOUND")
    store.release(active.id)
    expect(store.get(active.id, identity)).toBe(active)

    now = 111
    expect(() => store.claim(active.id, identity)).toThrowError("PLAN_EXPIRED")
  })

  it("evicts the least-recently-used plan at the process cap", () => {
    const store = new PlanStore(1_000)
    const first = store.create(identity, [file])
    for (let index = 1; index <= 32; index += 1) store.create(identity, [file])
    expect(() => store.get(first.id, identity)).toThrowError("PLAN_NOT_FOUND")
  })
})
