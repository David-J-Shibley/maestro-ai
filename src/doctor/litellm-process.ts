import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LitellmProcessInfo {
  running: boolean;
  detail: string;
  configPath?: string;
}

/** Detect a running LiteLLM server process (not editors like `vi litellm.yaml`). */
export function detectLitellmProcess(): LitellmProcessInfo {
  try {
    const out = execSync("pgrep -fl litellm 2>/dev/null || true", { encoding: "utf8" }).trim();
    const lines = out.split("\n").filter(Boolean);
    const serverLine = lines.find((l) => /\blitellm\b/.test(l) && !/\bvi\s+/.test(l));
    const configPath = serverLine
      ? serverLine.match(/--config\s+(\S+)/)?.[1]?.replace(/^~/, homedir())
      : undefined;
    return {
      running: Boolean(serverLine),
      detail: serverLine ?? lines[0] ?? "no litellm server process found",
      configPath,
    };
  } catch {
    return { running: false, detail: "could not check process" };
  }
}

/** Common LiteLLM config paths when the process line omits --config. */
export function guessLitellmConfigPaths(): string[] {
  const home = homedir();
  return [
    join(home, ".maestro-ai", "litellm.yaml"),
    join(home, "litellm.yaml"),
    join(home, "litellm-featherless.yaml"),
    join(process.cwd(), "litellm.yaml"),
    join(process.cwd(), "litellm-featherless.yaml"),
  ].filter((p) => existsSync(p));
}
