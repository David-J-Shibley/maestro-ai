import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  clearModelCatalogCache,
  fetchModelCatalog,
  isModelInCatalog,
  validateEndpointModel,
} from "../src/provider/model-catalog.js";
import type { ModelEndpointConfig } from "../src/types.js";

const LITELLM: ModelEndpointConfig = {
  provider: "litellm",
  model: "qwen3-4b",
  baseUrl: "http://localhost:4000/v1",
  apiKey: "sk-test",
};

describe("isModelInCatalog", () => {
  it("matches exact and case-insensitive ids", () => {
    expect(isModelInCatalog("glm", ["glm", "sonnet"])).toBe(true);
    expect(isModelInCatalog("GLM", ["glm"])).toBe(true);
  });

  it("matches ollama tag variants", () => {
    expect(isModelInCatalog("qwen3:8b", ["qwen3:8b", "llama3.2:latest"])).toBe(true);
    expect(isModelInCatalog("qwen3:8b", ["qwen3:8b-custom"])).toBe(true);
  });

  it("returns false when model is missing", () => {
    expect(isModelInCatalog("qwen3-4b", ["glm", "sonnet"])).toBe(false);
  });
});

describe("validateEndpointModel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearModelCatalogCache();
  });

  it("fails when gateway is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      })
    );
    const result = await validateEndpointModel(LITELLM);
    expect(result.reachable).toBe(false);
    expect(result.modelRegistered).toBe(false);
    expect(result.error).toContain("connection refused");
  });

  it("fails when model is not in catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "glm" }, { id: "sonnet" }],
        }),
      }))
    );
    const result = await validateEndpointModel(LITELLM);
    expect(result.reachable).toBe(true);
    expect(result.modelRegistered).toBe(false);
    expect(result.error).toContain('model "qwen3-4b" not in gateway catalog');
    expect(result.error).toContain("glm");
  });

  it("passes when model is listed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "qwen3-4b" }, { id: "glm" }],
        }),
      }))
    );
    const result = await validateEndpointModel(LITELLM);
    expect(result.reachable).toBe(true);
    expect(result.modelRegistered).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("reuses catalog cache per baseUrl", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "qwen3-4b" }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchModelCatalog(LITELLM);
    await fetchModelCatalog({ ...LITELLM, model: "glm" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
