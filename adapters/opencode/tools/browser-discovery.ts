import { tool } from "@opencode-ai/plugin"
import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { delimiter, join } from "node:path"

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export default tool({
  description: "Discover real installed Chrome, Chromium, Brave, or Edge executables before browser QA on macOS, Linux, or Windows.",
  args: {},
  async execute() {
    const names = process.platform === "win32"
      ? ["chrome.exe", "msedge.exe", "brave.exe"]
      : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave", "brave-browser", "microsoft-edge"]
    const candidates = (process.env.PATH ?? "").split(delimiter).filter(Boolean)
      .flatMap((directory) => names.map((name) => join(directory, name)))

    if (process.platform === "darwin") {
      candidates.push(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      )
    } else if (process.platform === "win32") {
      const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
        .filter((value): value is string => Boolean(value))
      for (const root of roots) {
        candidates.push(
          join(root, "Google", "Chrome", "Application", "chrome.exe"),
          join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
          join(root, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        )
      }
    }

    const found: string[] = []
    for (const candidate of [...new Set(candidates)]) {
      if (await isExecutable(candidate)) found.push(candidate)
    }
    return found.length
      ? `Installed browser executables:\n${found.map((candidate) => `- ${candidate}`).join("\n")}`
      : "No supported Chrome, Chromium, Brave, or Edge executable was found. Browser QA is unavailable until one is installed or Playwright downloads its managed browser."
  },
})
