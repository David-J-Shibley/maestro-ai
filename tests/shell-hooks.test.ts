import { describe, expect, it } from "vitest";
import { buildEvaluatorHooks, makeShellHook } from "../src/evaluator/shell-hooks.js";

describe("shell evaluator hooks", () => {
  it("passes on exit 0", async () => {
    const hook = makeShellHook("true");
    expect(await hook()).toBe(true);
  });

  it("fails on non-zero exit", async () => {
    const hook = makeShellHook("false");
    expect(await hook()).toBe(false);
  });

  it("builds optional test and build hooks", async () => {
    const hooks = buildEvaluatorHooks({
      runTests: "true",
      runBuild: "false",
    });
    expect(hooks.runTests).toBeTruthy();
    expect(hooks.runBuild).toBeTruthy();
    expect(await hooks.runTests!()).toBe(true);
    expect(await hooks.runBuild!()).toBe(false);
  });
});
