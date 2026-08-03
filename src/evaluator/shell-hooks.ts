import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface ShellHookOptions {
  /** Working directory for the command (default: process.cwd()) */
  cwd?: string;
  /** Timeout in ms (default: 120_000) */
  timeoutMs?: number;
}

/**
 * Build an evaluator hook that runs a shell command.
 * Exit code 0 → pass; non-zero or timeout → fail.
 */
export function makeShellHook(
  command: string,
  options: ShellHookOptions = {}
): () => Promise<boolean> {
  const cwd = options.cwd ?? process.cwd();
  const timeout = options.timeoutMs ?? 120_000;

  return async () => {
    try {
      await execAsync(command, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 });
      return true;
    } catch {
      return false;
    }
  };
}

export function buildEvaluatorHooks(input: {
  runTests?: string;
  runBuild?: string;
  cwd?: string;
}): { runTests?: () => Promise<boolean>; runBuild?: () => Promise<boolean> } {
  const hooks: {
    runTests?: () => Promise<boolean>;
    runBuild?: () => Promise<boolean>;
  } = {};

  if (typeof input.runTests === "string" && input.runTests.trim()) {
    hooks.runTests = makeShellHook(input.runTests.trim(), { cwd: input.cwd });
  }
  if (typeof input.runBuild === "string" && input.runBuild.trim()) {
    hooks.runBuild = makeShellHook(input.runBuild.trim(), { cwd: input.cwd });
  }

  return hooks;
}
