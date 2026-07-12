import { describe, expect, it } from "vitest";
import { PACKAGE_VERSION } from "../src/version.js";

describe("CLI version", () => {
  it("PACKAGE_VERSION matches package.json", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });
});
