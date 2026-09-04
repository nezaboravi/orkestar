import { tool } from "@opencode-ai/plugin"
import { execFile } from "node:child_process"
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, isAbsolute, join } from "node:path"
import { promisify } from "node:util"

const executeFile = promisify(execFile)
const MAX_BUFFER = 262144
const TIMEOUT = 45000
const SESSION_ID = /^ses_[A-Za-z0-9]+$/
const SHIPPED_ROLES = new Set(["explorer", "dev-builder", "verifier", "task-manager", "browser-ops", "dev-planner", "dev-tester", "dev-auditor", "frontend-qa", "reviewer", "product-designer"])

type RuntimeProfile = { permissionEnvelope?: unknown, model?: unknown }

function requireExactArgs(args: Record<string, unknown>): void {
  const keys = ["projectId", "profile", "name", "runId", "task"]
  if (Object.keys(args).length !== keys.length || keys.some((key) => !Object.hasOwn(args, key))) {
    throw new Error("Dispatch accepts only projectId, profile, name, runId, and task")
  }
}

function nonBlank(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`Invalid ${label}`)
  return value.trim()
}

function commandForTool(value: unknown): string {
  if (typeof value !== "string") throw new Error("Solo OpenCode tool has no command")
  const command = value.trim()
  if (command === "opencode") return command
  if (isAbsolute(command) && basename(command) === "opencode") return command
  throw new Error("Solo OpenCode tool command must be exactly opencode or an absolute opencode executable without flags")
}

function parseModel(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null
  try {
    const parsed = JSON.parse(value) as { providerID?: unknown, id?: unknown, modelID?: unknown }
    const provider = typeof parsed.providerID === "string" ? parsed.providerID : null
    const id = typeof parsed.id === "string" ? parsed.id : typeof parsed.modelID === "string" ? parsed.modelID : null
    return provider && id ? `${provider}/${id}` : id
  } catch {
    return value
  }
}

function parseBoundedJson(value: string, label: string): unknown {
  if (value.length > MAX_BUFFER) throw new Error(`${label} exceeds the bounded JSON limit`)
  try { return JSON.parse(value) } catch { throw new Error(`${label} is invalid JSON`) }
}

function identitySession(events: string): string {
  let sessionId: string | null = null
  let complete = false
  let response = false
  let toolUse = false
  for (const line of events.split(/\r?\n/)) {
    if (!line.trim()) continue
    let event: Record<string, unknown>
    try { event = JSON.parse(line) as Record<string, unknown> } catch { throw new Error("OpenCode identity probe returned invalid JSONL") }
    if (event.type === "error") throw new Error("OpenCode identity probe reported an error")
    if (typeof event.sessionID === "string") {
      if (sessionId && sessionId !== event.sessionID) throw new Error("OpenCode identity probe returned mixed sessions")
      sessionId = event.sessionID
    }
    const part = event.part as Record<string, unknown> | undefined
    if (part?.type === "tool" || part?.type === "tool-call" || part?.type === "tool_use") toolUse = true
    if (event.type === "tool" || event.type === "tool-call" || event.type === "tool_use") toolUse = true
    if (event.type === "step_finish" && part?.reason === "stop") complete = true
    if (event.type === "text" && part?.type === "text" && part.text === "IDENTITY_OK") response = true
  }
  if (!sessionId || !SESSION_ID.test(sessionId) || !complete || !response || toolUse) throw new Error("OpenCode identity probe did not complete as a tool-free response")
  return sessionId
}

function matchesProcessBaseCommand(value: unknown, command: string): boolean {
  return typeof value === "string" && (value === command || value.startsWith(`${command} `))
}

export default tool({
  description: "Dispatch one bounded OpenCode worker through Solo only after native role and model identity verification. This starts a process; it does not claim task completion.",
  args: {
    projectId: tool.schema.number().int().positive(),
    profile: tool.schema.string().min(1),
    name: tool.schema.string().min(1),
    runId: tool.schema.string().min(1),
    task: tool.schema.string().min(1),
  },
  async execute(args, context) {
    requireExactArgs(args as Record<string, unknown>)
    if (!Number.isSafeInteger(args.projectId) || args.projectId < 1) throw new Error("Invalid projectId")
    const profileKey = nonBlank(args.profile, "profile", 80)
    const name = nonBlank(args.name, "name", 120)
    const runId = nonBlank(args.runId, "runId", 120)
    const task = nonBlank(args.task, "task", 16384)
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
      throw new Error("Name is invalid or runId is not a UUID")
    }
    const directory = await realpath(context.directory)
    let runtime: { schemaVersion?: unknown, harness?: unknown, profiles?: Record<string, RuntimeProfile> }
    try { runtime = parseBoundedJson(await readFile(join(directory, ".agent-orchestra", "runtime", "opencode.json"), "utf8"), "Current project OpenCode runtime manifest") as { schemaVersion?: unknown, harness?: unknown, profiles?: Record<string, RuntimeProfile> } } catch { throw new Error("Current project OpenCode runtime manifest is unavailable or invalid") }
    if (runtime.schemaVersion !== 1 || runtime.harness !== "opencode") throw new Error("Current project OpenCode runtime manifest has the wrong schema or harness")
    const profile = runtime.profiles?.[profileKey]
    const role = typeof profile?.permissionEnvelope === "string" ? profile.permissionEnvelope : null
    const model = typeof profile?.model === "string" ? profile.model : null
    if (!role || !SHIPPED_ROLES.has(role) || !model) throw new Error("Selected runtime profile has no shipped permission envelope and model")
    const dispatchDirectory = join(directory, ".agent-orchestra", "dispatch")
    async function writeReceipt(filename: string, receipt: Record<string, unknown>) {
      await mkdir(dispatchDirectory, { recursive: true })
      if (await realpath(dispatchDirectory) !== dispatchDirectory) throw new Error("Dispatch ledger directory must not be a symlink")
      await writeFile(join(dispatchDirectory, filename), `${JSON.stringify(receipt)}\n`, { mode: 0o600 })
    }

    const candidates = process.env.SOLO_CLI ? [process.env.SOLO_CLI] : ["solo",
      ...(process.platform === "darwin" ? ["/Applications/Solo.app/Contents/MacOS/solo-cli", join(homedir(), "Applications/Solo.app/Contents/MacOS/solo-cli")] : [])]
    let candidate = 0
    async function solo(command: string[]) {
      for (;;) {
        try {
          const { stdout } = await executeFile(candidates[candidate], [...command, "--json"], { cwd: directory, timeout: TIMEOUT, maxBuffer: MAX_BUFFER })
          const payload = parseBoundedJson(stdout, "Solo response") as { ok?: unknown, data?: unknown }
          if (payload.ok !== true || !payload.data) throw new Error("Solo command failed")
          return payload.data as Record<string, unknown>
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || candidate + 1 >= candidates.length) throw error
          candidate++
        }
      }
    }

    const project = await solo(["projects", "get", String(args.projectId)])
    if (project.id !== args.projectId || typeof project.path !== "string" || await realpath(project.path) !== directory) {
      throw new Error("Solo project does not match the current project")
    }
    const tools = await solo(["agents", "list"])
    const agentTools = Array.isArray(tools.agentTools) ? tools.agentTools as Record<string, unknown>[] : []
    const matching = agentTools.filter((entry) => entry.enabled === true && entry.toolType === "opencode" && Number.isSafeInteger(entry.id) && (entry.id as number) > 0)
    if (matching.length !== 1) throw new Error("Solo must have exactly one enabled OpenCode agent tool")
    const agentTool = matching[0]
    const agentCommand = commandForTool(agentTool.command)

    let config: Record<string, unknown> = {}
    if (process.env.OPENCODE_CONFIG_CONTENT) {
      try { config = parseBoundedJson(process.env.OPENCODE_CONFIG_CONTENT, "Existing OPENCODE_CONFIG_CONTENT") as Record<string, unknown> } catch { throw new Error("Existing OPENCODE_CONFIG_CONTENT is invalid JSON") }
    }
    const existingAgents = config.agent && typeof config.agent === "object" && !Array.isArray(config.agent) ? config.agent as Record<string, unknown> : {}
    const existingAgent = existingAgents[role] && typeof existingAgents[role] === "object" && !Array.isArray(existingAgents[role]) ? existingAgents[role] as Record<string, unknown> : {}
    const identityConfig = JSON.stringify({ ...config, agent: { ...existingAgents, [role]: { ...existingAgent, permission: "deny" } } })
    const identityTitle = runId
    const bootstrapStartedAt = Date.now()
    let sessionId: string
    try {
      const probe = await executeFile(agentCommand, ["run", "--agent", role, "--model", model, "--format", "json", "--title", identityTitle,
        "Identity-only probe. Reply exactly IDENTITY_OK. Do not use tools."], {
        cwd: directory, timeout: TIMEOUT, maxBuffer: MAX_BUFFER,
        env: { ...process.env, OPENCODE_CONFIG_CONTENT: identityConfig },
      })
      sessionId = identitySession(probe.stdout)
      const query = `SELECT id, directory, agent, model FROM session WHERE id = '${sessionId.replaceAll("'", "''")}' AND directory = '${directory.replaceAll("'", "''")}'`
      const db = await executeFile(agentCommand, ["db", query, "--format", "json"], { cwd: directory, timeout: TIMEOUT, maxBuffer: MAX_BUFFER })
      const rows = parseBoundedJson(db.stdout, "OpenCode session database response") as Array<Record<string, unknown>>
      if (!Array.isArray(rows) || rows.length !== 1 || rows[0].id !== sessionId || rows[0].directory !== directory
        || rows[0].agent !== role || parseModel(rows[0].model) !== model) throw new Error("OpenCode session database did not verify the requested role and model")
    } catch (error) {
      const failed = { schemaVersion: 1, ownerSessionId: context.sessionID, projectId: args.projectId, processId: null, sessionId: null, runId, profile: profileKey, role, model, taskStartedAt: null, bootstrapStartedAt, status: "bootstrap-failed" }
      await writeReceipt(`failed-${runId}.json`, failed)
      throw new Error("OpenCode native identity bootstrap failed; no Solo task was started")
    }

    const suppliedArguments = ["--session", sessionId, "--agent", role, "--model", model, "--prompt", task]
    const taskStartedAt = Date.now()
    const spawn = await solo(["processes", "spawn", "--project-id", String(args.projectId), "--kind", "agent", "--agent-tool-id", String(agentTool.id), "--name", name,
      "--arg", "--session", "--arg", sessionId, "--arg", "--agent", "--arg", role, "--arg", "--model", "--arg", model, "--arg", "--prompt", "--arg", task])
    const spawned = (spawn.process && typeof spawn.process === "object" ? spawn.process : spawn) as Record<string, unknown>
    if (!Number.isSafeInteger(spawned.id) || spawned.kind !== "agent") throw new Error("Solo did not return an agent process")
    const processId = spawned.id as number
    const receipt = { schemaVersion: 1, ownerSessionId: context.sessionID, projectId: args.projectId, processId, sessionId, runId, profile: profileKey, role, model, taskStartedAt, suppliedArguments: suppliedArguments.slice(0, 6), taskCharacters: task.length, launchArgumentsVerified: false, nativeIdentityVerifiedAtBootstrap: true, status: "started" }
    try {
      const processEntry = await solo(["processes", "get", String(processId)])
      if (processEntry.id !== processId || processEntry.projectId !== args.projectId || processEntry.kind !== "agent" || processEntry.name !== name || !matchesProcessBaseCommand(processEntry.command, agentCommand)) {
        throw new Error("Solo spawned process does not match the requested project, agent identity, or OpenCode base command")
      }
    } catch {
      await writeReceipt(`${sessionId}.json`, { ...receipt, status: "spawn-validation-failed" })
      try { await solo(["processes", "stop", String(processId)]) } catch { /* Preserve the failed receipt even when Solo cannot stop it. */ }
      throw new Error("Solo spawned process could not be validated and was stopped when possible")
    }
    await writeReceipt(`${sessionId}.json`, receipt)
    return JSON.stringify({ ...receipt, name, taskCompletion: "unverified", notice: "Solo process launch is recorded. Solo exposes only a display command, so launch arguments are not natively verified; collect and independently verify the completed session before claiming completion." })
  },
})
