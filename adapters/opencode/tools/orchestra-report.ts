import { tool } from "@opencode-ai/plugin"
import { execFile } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, parse, resolve } from "node:path"
import { promisify } from "node:util"

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

function exactNumber(value: number | null): ExactNumber {
  return typeof value === "number" && Number.isFinite(value) ? value : "unavailable"
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
    proof: tool.schema.array(tool.schema.object({
      criterion: tool.schema.string().describe("Observable acceptance criterion"),
      method: tool.schema.string().describe("Independent verification method"),
      result: tool.schema.enum(["passed", "failed", "unavailable"]),
      evidence: tool.schema.array(tool.schema.string()).describe("Exact test, observation, screenshot, or output proving the result"),
    })).describe("Requirement-to-evidence proof; command names alone are insufficient"),
    blockers: tool.schema.array(tool.schema.string()).describe("Failed, skipped, or unavailable promised checks; empty only for DONE"),
  },
  async execute(args, context) {
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
    if (args.status === "DONE" && args.workflow === "development" && !sessionHasRole(rows, "dev-lead")) {
      throw new Error("DONE development run requires a recorded dev-lead session")
    }
    if (args.status === "DONE" && args.workflow === "development" && !sessionHasRole(rows, "dev-auditor")) {
      throw new Error("DONE development run requires a recorded independent dev-auditor session")
    }
    if (args.status === "DONE" && args.designRequired && !sessionHasRole(rows, "product-designer")) {
      throw new Error("DONE user-facing design run requires a recorded product-designer session")
    }
    if (args.status === "DONE" && args.visualProofRequired && !sessionHasRole(rows, "frontend-qa")) {
      throw new Error("DONE UI run requires a recorded frontend-qa session")
    }

    const agents = rows.map((row, index) => {
      const tokenParts = {
        input: exactNumber(row.tokens_input),
        output: exactNumber(row.tokens_output),
        reasoning: exactNumber(row.tokens_reasoning),
        cacheRead: exactNumber(row.tokens_cache_read),
        cacheWrite: exactNumber(row.tokens_cache_write),
      }
      const knownCoreTokens = [tokenParts.input, tokenParts.output, tokenParts.reasoning]
      const tokenTotal = knownCoreTokens.every((value) => typeof value === "number")
        ? (knownCoreTokens as number[]).reduce((sum, value) => sum + value, 0)
        : "unavailable"
      return {
        sessionId: row.id,
        parentSessionId: row.parent_id,
        agent: row.agent || (index === 0 ? "lenka" : "unavailable"),
        task: row.title || "unavailable",
        model: parseModel(row.model),
        tokens: { ...tokenParts, total: tokenTotal },
        cost: exactNumber(row.cost),
      }
    })
    const telemetryComplete = agents.every((agent) =>
      agent.model !== "unavailable" && agent.tokens.total !== "unavailable" && agent.cost !== "unavailable",
    )
    if (args.status === "DONE" && !telemetryComplete) {
      throw new Error("DONE requires complete native per-session model, token, and cost telemetry; use PARTIAL")
    }
    const projectDirectory = safeProjectDirectory(context.directory)
    const knownTokenTotals = agents.map((agent) => agent.tokens.total).filter((value): value is number => typeof value === "number")
    const knownCosts = agents.map((agent) => agent.cost).filter((value): value is number => typeof value === "number")
    const audit = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      harness: "opencode",
      sessionId: context.sessionID,
      project: projectDirectory,
      status: args.status,
      summary: args.summary,
      taskavel: args.taskavel,
      agents,
      totals: {
        tokens: knownTokenTotals.reduce((sum, value) => sum + value, 0),
        cost: knownCosts.reduce((sum, value) => sum + value, 0),
        complete: telemetryComplete,
      },
      proof: args.proof,
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
    const total = audit.totals.complete
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
