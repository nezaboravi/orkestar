import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, parse, resolve } from "node:path"

function safeProjectDirectory(directory: string): string {
  const project = resolve(directory)
  if (project === parse(project).root) {
    throw new Error(`Refusing to persist Orkestar state at filesystem root: ${project}`)
  }
  return project
}

async function handoffPath(directory: string): Promise<string> {
  const project = safeProjectDirectory(directory)
  const dotGit = join(project, ".git")

  try {
    const metadata = await stat(dotGit)
    if (metadata.isDirectory()) return join(dotGit, "opencode-handoff.md")

    const pointer = await readFile(dotGit, "utf8")
    const match = pointer.match(/^gitdir:\s*(.+)\s*$/m)
    if (match) {
      const gitDirectory = isAbsolute(match[1])
        ? match[1]
        : resolve(dirname(dotGit), match[1])
      return join(gitDirectory, "opencode-handoff.md")
    }
  } catch {
    // A non-git project keeps its handoff in ignored project-local state.
  }

  return join(project, ".agent-orchestra", "handoff.md")
}

export const OrchestraStatePlugin: Plugin = async () => ({
  tool: {
    handoff_save: tool({
      description: "Save an Orkestar handoff in the active project, never the filesystem root.",
      args: {
        content: tool.schema.string().describe("Concise Markdown handoff without secrets or credentials"),
      },
      async execute({ content }, context) {
        const target = await handoffPath(context.directory)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, `${content.trim()}\n`, { encoding: "utf8", mode: 0o600 })
        return `Handoff saved: ${target}`
      },
    }),
    handoff_load: tool({
      description: "Load the active project's last Orkestar handoff.",
      args: {},
      async execute(_args, context) {
        const target = await handoffPath(context.directory)
        try {
          return await readFile(target, "utf8")
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return `No handoff exists for ${safeProjectDirectory(context.directory)}.`
          }
          throw error
        }
      },
    }),
  },
})

export { handoffPath, safeProjectDirectory }
