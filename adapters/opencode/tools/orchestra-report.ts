import { tool } from "@opencode-ai/plugin"
import { execFile } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, parse, resolve } from "node:path"
import { promisify } from "node:util"
import { reportTrackerGate } from "../../../report-tracker-gate.mjs"

const executeFile = promisify(execFile)

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function parseModel(value: unknown): string {
  if (typeof value !== "string") return "unavailable"
  try {
    const parsed = JSON.parse(value) as { providerID?: string; id?: string; modelID?: string }
    const provider = parsed.providerID
    const model = parsed.id ?? parsed.modelID
    return provider && model ? `${provider}/${model}` : model ?? value
  } catch {
    return value || "unavailable"
  }
}

type SessionRow = {
  id: string
  parent_id: string | null
  agent: string | null
  title: string | null
  model: string | null
  cost: number | null
  tokens_input: number | null
  tokens_output: number | null
  tokens_reasoning: number | null
  tokens_cache_read: number | null
  tokens_cache_write: number | null
}

type ExactNumber = number | "unavailable"

function exactTokens(value: number | null): ExactNumber {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : "unavailable"
}

function exactCost(value: number | null): ExactNumber {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : "unavailable"
}

function exactSum(values: ExactNumber[], tokens: boolean): ExactNumber {
  if (values.some((value) => typeof value !== "number")) return "unavailable"
  const sum = (values as number[]).reduce((total, value) => total + value, 0)
  return tokens ? exactTokens(sum) : exactCost(sum)
}

function safeProjectDirectory(directory: string): string {
  const project = resolve(directory)
  if (project === parse(project).root) {
    throw new Error(`Refusing to persist an Orkestar report at filesystem root: ${project}`)
  }
  return project
}

function sessionHasRole(rows: SessionRow[], role: string): boolean {
  const expected = role.toLowerCase()
  return rows.some((row) => row.agent?.toLowerCase() === expected)
}

export default tool({
  description: "Finalize an Orkestar run with an auditable agent, model, token, cost, verification, and blocker report.",
  args: {
    status: tool.schema.enum(["DONE", "PARTIAL", "FAILED"]).describe("Truthful completion state"),
    summary: tool.schema.string().describe("One-sentence outcome summary"),
    workflow: tool.schema.enum(["development", "other"]).describe("Whether the run used the development team workflow"),
    designRequired: tool.schema.boolean().describe("True for a new or materially changed user-facing interface"),
    visualProofRequired: tool.schema.boolean().describe("True when user-facing UI behavior changed"),
    taskavel: tool.schema.enum(["synced", "not-requested", "unavailable"]).describe("Observed Taskavel coordination state"),
    trackerReconciliation: tool.schema.object({
      projectId: tool.schema.string(),
      checkedAt: tool.schema.number().int().nonnegative(),
      maxSnapshotAgeMs: tool.schema.number().int().min(1).max(300000).optional(),
      requiredTasks: tool.schema.array(tool.schema.object({
        taskId: tool.schema.string(), doneColumnId: tool.schema.string(), claimedComplete: tool.schema.boolean(),
        lastUpdateAttemptAt: tool.schema.number().int().nonnegative(),
        proof: tool.schema.object({ accepted: tool.schema.boolean(), evidenceIds: tool.schema.array(tool.schema.string()) }).strict(),
      }).strict()).min(1).max(10000),
      snapshots: tool.schema.array(tool.schema.object({
        projectId: tool.schema.string(), taskId: tool.schema.string(), columnId: tool.schema.string(),
        completed: tool.schema.boolean(), readAt: tool.schema.number().int().nonnegative(),
      }).strict()).max(10000),
    }).strict().optional().describe("Required for DONE with synced Taskavel. Supply actual normalized adapter readbacks and accepted per-task proof. This validates the packet, not network provenance or reviewer authenticity."),
    review: tool.schema.object({
      sessionId: tool.schema.string().describe("Independent reviewer session ID"),
      verdict: tool.schema.enum(["APPROVED", "CHANGES_REQUIRED"]),
      security: tool.schema.object({
        status: tool.schema.enum(["PASS", "FAIL", "UNVERIFIED", "NOT_APPLICABLE"]),
        evidence: tool.schema.array(tool.schema.string()),
      }),
      performance: tool.schema.object({
        status: tool.schema.enum(["PASS", "FAIL", "UNVERIFIED", "NOT_APPLICABLE"]),
        evidence: tool.schema.array(tool.schema.string()),
      }),
    }).optional().describe("Required for DONE development; NOT_APPLICABLE needs change-specific justification in evidence"),
    proof: tool.schema.array(tool.schema.object({
      criterion: tool.schema.string().describe("Observable acceptance criterion"),
      method: tool.schema.string().describe("Independent verification method"),
      result: tool.schema.enum(["passed", "failed", "unavailable"]),
      evidence: tool.schema.array(tool.schema.string()).describe("Exact test, observation, screenshot, or output proving the result"),
    })).describe("Requirement-to-evidence proof; command names alone are insufficient"),
    blockers: tool.schema.array(tool.schema.string()).describe("Failed, skipped, or unavailable promised checks; empty only for DONE"),
  },
  async execute(args, context) {
    const trackerReconciliation = reportTrackerGate(args)
    if (args.status === "DONE" && args.blockers.length > 0) {
      throw new Error("DONE cannot contain blockers; use PARTIAL or FAILED")
    }
    if (args.status === "PARTIAL" && args.blockers.length === 0) {
      throw new Error("PARTIAL requires at least one explicit blocker")
    }
    if (args.status === "DONE" && !args.proof.length) {
      throw new Error("DONE requires behavior-level proof, not only successful commands")
    }
    if (args.status === "DONE" && args.proof.some((item) => item.result !== "passed" || item.evidence.length === 0)) {
      throw new Error("DONE requires direct evidence for every passed acceptance criterion")
    }
    if (args.status === "DONE" && args.taskavel === "unavailable") {
      throw new Error("DONE cannot claim unavailable requested Taskavel coordination; use PARTIAL")
    }

    const query = `WITH RECURSIVE tree AS (
      SELECT id, parent_id, agent, title, model, cost, tokens_input, tokens_output,
             tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created
      FROM session WHERE id = ${sqlString(context.sessionID)}
      UNION ALL
      SELECT s.id, s.parent_id, s.agent, s.title, s.model, s.cost, s.tokens_input,
             s.tokens_output, s.tokens_reasoning, s.tokens_cache_read, s.tokens_cache_write, s.time_created
      FROM session s JOIN tree t ON s.parent_id = t.id
    ) SELECT * FROM tree ORDER BY time_created ASC`
    const { stdout } = await executeFile("opencode", ["db", query, "--format", "json"], {
      cwd: context.directory,
      maxBuffer: 10 * 1024 * 1024,
    })
    const rows = JSON.parse(stdout) as SessionRow[]
    if (!rows.length) throw new Error(`OpenCode did not return session telemetry for ${context.sessionID}`)
    if (args.status === "DONE" && args.workflow === "development") {
      for (const role of ["dev-planner", "dev-builder", "dev-tester", "reviewer", "dev-auditor"]) {
        if (!sessionHasRole(rows, role)) {
          throw new Error(`DONE development run requires a recorded ${role} session`)
        }
      }
      const review = args.review
      if (!review || review.verdict !== "APPROVED") {
        throw new Error("DONE development requires an APPROVED independent review")
      }
      if (review.sessionId === context.sessionID || !rows.some((row) => row.id === review.sessionId && row.agent === "reviewer")) {
        throw new Error("Review must reference the recorded independent reviewer session")
      }
      for (const category of ["security", "performance"] as const) {
        const check = review[category]
        if (!["PASS", "NOT_APPLICABLE"].includes(check.status) || !check.evidence.some((item) => item.trim())) {
          throw new Error(`DONE requires verified ${category} review evidence or explicit non-applicability justification`)
        }
      }
    }
    if (args.status === "DONE" && args.designRequired && !sessionHasRole(rows, "product-designer")) {
      throw new Error("DONE user-facing design run requires a recorded product-designer session")
    }
    if (args.status === "DONE" && args.visualProofRequired && !sessionHasRole(rows, "frontend-qa")) {
      throw new Error("DONE UI run requires a recorded frontend-qa session")
    }

    const agents = rows.map((row, index) => {
      const tokenParts = {
        input: exactTokens(row.tokens_input),
        output: exactTokens(row.tokens_output),
        reasoning: exactTokens(row.tokens_reasoning),
        cacheRead: exactTokens(row.tokens_cache_read),
        cacheWrite: exactTokens(row.tokens_cache_write),
      }
      const knownCoreTokens = [tokenParts.input, tokenParts.output, tokenParts.reasoning]
      const tokenTotal = Object.values(tokenParts).every((value) => typeof value === "number")
        ? exactSum(knownCoreTokens, true) : "unavailable"
      return {
        sessionId: row.id,
        parentSessionId: row.parent_id,
        agent: row.agent || (index === 0 ? "lenka" : "unavailable"),
        task: row.title || "unavailable",
        model: parseModel(row.model),
        tokens: { ...tokenParts, total: tokenTotal },
        cost: exactCost(row.cost),
      }
    })
    const totalTokens = exactSum(agents.map((agent) => agent.tokens.total), true)
    const totalCost = exactSum(agents.map((agent) => agent.cost), false)
    const telemetryComplete = totalTokens !== "unavailable" && totalCost !== "unavailable" && agents.every((agent) =>
      agent.model !== "unavailable" && agent.tokens.total !== "unavailable" && agent.cost !== "unavailable",
    )
    if (args.status === "DONE" && !telemetryComplete) {
      throw new Error("DONE requires complete native per-session model, token, and cost telemetry; use PARTIAL")
    }
    const projectDirectory = safeProjectDirectory(context.directory)
    const audit = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      harness: "opencode",
      sessionId: context.sessionID,
      project: projectDirectory,
      status: args.status,
      summary: args.summary,
      taskavel: args.taskavel,
      trackerReconciliation,
      agents,
      totals: {
        tokens: totalTokens,
        cost: totalCost,
        complete: telemetryComplete,
      },
      proof: args.proof,
      review: args.review ?? null,
      blockers: args.blockers,
      telemetry: "Exact OpenCode session database values; no estimates.",
    }

    const directory = join(projectDirectory, ".agent-orchestra", "runs")
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `${context.sessionID}.json`), `${JSON.stringify(audit, null, 2)}\n`, { mode: 0o600 })
    await writeFile(join(directory, "latest.json"), `${JSON.stringify(audit, null, 2)}\n`, { mode: 0o600 })

    const lines = agents.map((agent) => {
      const cost = typeof agent.cost === "number" ? `$${agent.cost.toFixed(6)}` : "cost unavailable"
      return `- ${agent.agent}: ${agent.model} — ${agent.tokens.total} tokens — ${cost}`
    })
    const proof = args.proof.map((item) =>
      `- [${item.result}] ${item.criterion} — ${item.method} — ${item.evidence.join("; ")}`,
    )
    const total = audit.totals.complete && typeof audit.totals.cost === "number"
      ? `${audit.totals.tokens} tokens — $${audit.totals.cost.toFixed(6)}`
      : "unavailable (native per-session telemetry is incomplete)"
    return [
      `ORKESTAR RUN ${audit.status}`,
      audit.summary,
      `Taskavel: ${audit.taskavel}`,
      ...lines,
      `Total: ${total}`,
      ...(proof.length ? ["Behavior proof:", ...proof] : []),
      ...(audit.blockers.length ? ["Blockers:", ...audit.blockers.map((item) => `- ${item}`)] : []),
      `Saved: ${join(directory, "latest.json")}`,
    ].join("\n")
  },
})
