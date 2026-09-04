import { tool } from "@opencode-ai/plugin"
import { execFile } from "node:child_process"
import { readFile, realpath } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

const executeFile = promisify(execFile)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`

export default tool({
  description: "Wait for a dispatcher-owned worker using bounded native session checks. Pending is not completion; no terminal polling or model calls.",
  args: { sessionId: tool.schema.string() },
  async execute({ sessionId }, context) {
    if (!/^ses_[A-Za-z0-9]+$/.test(sessionId)) throw new Error("Invalid session ID")
    const directory = await realpath(context.directory)
    const target = join(directory, ".agent-orchestra", "dispatch", `${sessionId}.json`)
    if (await realpath(target) !== target) throw new Error("Dispatch receipt must not be redirected")
    const raw = await readFile(target, "utf8")
    if (Buffer.byteLength(raw) > 16384) throw new Error("Oversized dispatch receipt")
    const receipt = JSON.parse(raw)
    if (receipt.status !== 'started' || receipt.schemaVersion !== 1 || receipt.ownerSessionId !== context.sessionID
      || receipt.sessionId !== sessionId || !Number.isSafeInteger(receipt.taskStartedAt)
      || receipt.taskStartedAt > Date.now() || typeof receipt.role !== "string"
      || typeof receipt.model !== "string") throw new Error("Invalid or foreign dispatch receipt")
    // A stalled worker cannot keep the orchestrator in an unbounded retry loop.
    if (Date.now() - receipt.taskStartedAt > 15 * 60 * 1000) {
      return JSON.stringify({ status: "PARTIAL", sessionId, blockers: ["Worker deadline exceeded; do not retry this phase automatically"] })
    }
    const until = Date.now() + 30000
    do {
      context.abort?.throwIfAborted()
      const sql = `SELECT s.id, s.agent, s.model, s.cost, s.tokens_input, s.tokens_output,
        (SELECT count(*) FROM message WHERE session_id=s.id AND json_extract(data,'$.role')='user') AS user_count,
        (SELECT data FROM message WHERE session_id=s.id ORDER BY time_created DESC,id DESC LIMIT 1) AS last_message
        FROM session s WHERE s.id=${quote(sessionId)} AND s.directory=${quote(directory)}`
      const { stdout } = await executeFile("opencode", ["db", sql, "--format", "json"], {
        cwd: directory, timeout: 10000, maxBuffer: 262144, signal: context.abort,
      })
      const rows = JSON.parse(stdout)
      if (!Array.isArray(rows) || rows.length !== 1) throw new Error("Native worker session is missing")
      const row = rows[0]
      const model = typeof row.model === "string" ? JSON.parse(row.model) : row.model
      if (row.agent !== receipt.role || `${model?.providerID}/${model?.id ?? model?.modelID}` !== receipt.model) {
        throw new Error("Native worker role/model changed; stop this phase")
      }
      const last = row.last_message ? JSON.parse(row.last_message) : null
      if (row.user_count >= 2 && last?.role === "assistant" && last.error) {
        return JSON.stringify({ status: "FAILED", sessionId, blockers: ["Native worker reported an error; inspect provider/session error without retrying"] })
      }
      if (row.user_count >= 2 && last?.role === "assistant" && last.time?.completed
        && ["stop", "end_turn"].includes(last.finish)) {
        return JSON.stringify({ status: "RESULT_READY", sessionId, role: row.agent,
          model: receipt.model, cost: row.cost ?? "unavailable",
          inputTokens: row.tokens_input ?? "unavailable", outputTokens: row.tokens_output ?? "unavailable",
          notice: "Native turn ended, not proof of success. Collect the dedicated result and independent evidence." })
      }
      if (Date.now() >= until) break
      await sleep(3000)
    } while (Date.now() < until)
    return JSON.stringify({ status: "PENDING", sessionId, next: "Call orchestra-solo-wait again; do not poll terminal output or start a replacement worker" })
  },
})
