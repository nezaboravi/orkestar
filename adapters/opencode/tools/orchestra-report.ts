import { tool } from "@opencode-ai/plugin"
import { execFile } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
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

export default tool({
  description: "Finalize an Orkestar run with an auditable agent, model, token, cost, verification, and blocker report.",
  args: {
    status: tool.schema.enum(["DONE", "PARTIAL", "FAILED"]).describe("Truthful completion state"),
    summary: tool.schema.string().describe("One-sentence outcome summary"),
    verification: tool.schema.array(tool.schema.string()).describe("Checks performed and their exact outcomes"),
    blockers: tool.schema.array(tool.schema.string()).describe("Failed, skipped, or unavailable promised checks; empty only for DONE"),
  },
  async execute(args, context) {
    if (args.status === "DONE" && args.blockers.length > 0) {
      throw new Error("DONE cannot contain blockers; use PARTIAL or FAILED")
    }
    if (args.status === "PARTIAL" && args.blockers.length === 0) {
      throw new Error("PARTIAL requires at least one explicit blocker")
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

    const agents = rows.map((row, index) => {
      const tokens = {
        input: Number(row.tokens_input ?? 0),
        output: Number(row.tokens_output ?? 0),
        reasoning: Number(row.tokens_reasoning ?? 0),
        cacheRead: Number(row.tokens_cache_read ?? 0),
        cacheWrite: Number(row.tokens_cache_write ?? 0),
      }
      return {
        sessionId: row.id,
        parentSessionId: row.parent_id,
        agent: row.agent || (index === 0 ? "lenka" : "unavailable"),
        task: row.title || "unavailable",
        model: parseModel(row.model),
        tokens: { ...tokens, total: tokens.input + tokens.output + tokens.reasoning },
        cost: Number(row.cost ?? 0),
      }
    })
    const audit = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      harness: "opencode",
      sessionId: context.sessionID,
      project: context.worktree,
      status: args.status,
      summary: args.summary,
      agents,
      totals: {
        tokens: agents.reduce((sum, agent) => sum + agent.tokens.total, 0),
        cost: agents.reduce((sum, agent) => sum + agent.cost, 0),
      },
      verification: args.verification,
      blockers: args.blockers,
      telemetry: "Exact OpenCode session database values; no estimates.",
    }

    const directory = join(context.worktree, ".agent-orchestra", "runs")
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `${context.sessionID}.json`), `${JSON.stringify(audit, null, 2)}\n`, { mode: 0o600 })
    await writeFile(join(directory, "latest.json"), `${JSON.stringify(audit, null, 2)}\n`, { mode: 0o600 })

    const lines = agents.map((agent) =>
      `- ${agent.agent}: ${agent.model} — ${agent.tokens.total} tokens — $${agent.cost.toFixed(6)}`,
    )
    return [
      `ORKESTAR RUN ${audit.status}`,
      audit.summary,
      ...lines,
      `Total: ${audit.totals.tokens} tokens — $${audit.totals.cost.toFixed(6)}`,
      ...(audit.verification.length ? ["Verification:", ...audit.verification.map((item) => `- ${item}`)] : []),
      ...(audit.blockers.length ? ["Blockers:", ...audit.blockers.map((item) => `- ${item}`)] : []),
      `Saved: ${join(directory, "latest.json")}`,
    ].join("\n")
  },
})
