// @ts-nocheck -- Ported behavioral suite intentionally uses lightweight fetch doubles.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import {
  BUILTIN_DEFAULT_REGION_IDS,
  VERTEX_MODELS,
  VERTEX_IMAGE_MODELS,
  VERTEX_REGIONS,
  inferRegionGroup,
  resolveDefaultRegionIds,
  resolveProbeModels,
  resolveProbeRegions,
  resolveVertexChatModels,
  resolveVertexProject,
} from "./catalog.js";
import {
  buildVertexProbeBody,
  classifyVertexResult,
  mapWithConcurrency,
  probeRegionModel,
  resolveProbeConcurrency,
  resolveProbeTimeoutMs,
  rollupByModel,
  runRegionMatrix,
  selectByIds,
  summarizeMatrix,
  VERTEX_IMAGE_PROBE_MAX_OUTPUT_TOKENS,
  vertexErrorMessage,
  vertexGenerateContentUrl,
  vertexHost,
} from "./region-probe.js";
import { getVertexAccessToken, resetVertexTokenCache } from "./vertex-auth.js";
import { createApp } from "./app.js";

const PROJECT_ENV_KEYS = ["GCP_PROJECT", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GCP_PROJECT_ID"];
const PROBE_ENV_KEYS = [
  "VERTEX_PROBE_MODELS",
  "VERTEX_PROBE_REGIONS",
  "VERTEX_PROBE_DEFAULT_REGIONS",
  "VERTEX_PROBE_TIMEOUT_MS",
  "VERTEX_PROBE_CONCURRENCY",
];

function clearProjectEnv() {
  for (const k of [...PROJECT_ENV_KEYS, ...PROBE_ENV_KEYS]) delete process.env[k];
}

function vertexOk() {
  return {
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: "pong" }] }, finishReason: "STOP" }],
    }),
  };
}

function vertexNotFound(model, region) {
  return {
    status: 404,
    json: async () => ({
      error: {
        code: 404,
        message: `Publisher model \`projects/p/locations/${region}/publishers/google/models/${model}\` was not found.`,
      },
    }),
  };
}

describe("vertexHost / url", () => {
  it("uses the right host per endpoint shape", () => {
    expect(vertexHost("global")).toBe("https://aiplatform.googleapis.com");
    expect(vertexHost("eu")).toBe("https://aiplatform.eu.rep.googleapis.com");
    expect(vertexHost("us")).toBe("https://aiplatform.us.rep.googleapis.com");
    expect(vertexHost("europe-west4")).toBe("https://europe-west4-aiplatform.googleapis.com");
  });

  it("builds the publisher model path", () => {
    expect(
      vertexGenerateContentUrl({ project: "p", region: "eu", model: "gemini-3.7-flash" }),
    ).toBe(
      "https://aiplatform.eu.rep.googleapis.com/v1/projects/p/locations/eu/publishers/google/models/gemini-3.7-flash:generateContent",
    );
  });

  it("sends camelCase generationConfig, unlike the Developer API", () => {
    const body = buildVertexProbeBody("ping");
    expect(body.generationConfig.maxOutputTokens).toBe(16);
    expect(body.generationConfig.responseModalities).toBeUndefined();
    expect(body.contents[0].parts[0].text).toBe("ping");
  });

  it("asks image models for TEXT+IMAGE so a region miss is not a bad request", () => {
    const body = buildVertexProbeBody("ping", "gemini-3.1-flash-lite-image");
    expect(body.generationConfig.responseModalities).toEqual(["TEXT", "IMAGE"]);
    expect(body.generationConfig.maxOutputTokens).toBe(VERTEX_IMAGE_PROBE_MAX_OUTPUT_TOKENS);
  });
});

describe("resolveVertexProject", () => {
  beforeEach(clearProjectEnv);
  afterEach(clearProjectEnv);

  it("prefers the environment over the request", () => {
    process.env.GCP_PROJECT = "from-env";
    expect(resolveVertexProject("from-user")).toEqual({ project: "from-env", source: "env" });
  });

  it("falls back to the request only when no env var is set", () => {
    expect(resolveVertexProject("from-user")).toEqual({ project: "from-user", source: "request" });
  });

  it("accepts the Cloud Run variable too", () => {
    process.env.GOOGLE_CLOUD_PROJECT = "cloud-run-project";
    expect(resolveVertexProject(null).project).toBe("cloud-run-project");
  });

  it("reports nothing when neither side supplies one", () => {
    expect(resolveVertexProject("   ")).toEqual({ project: null, source: null });
  });
});

describe("classifyVertexResult", () => {
  it("maps HTTP outcomes to availability verdicts", () => {
    expect(classifyVertexResult(200, {})).toBe("available");
    expect(classifyVertexResult(404, { error: { message: "not found" } })).toBe("unavailable");
    expect(classifyVertexResult(429, { error: { message: "quota" } })).toBe("quota");
    expect(classifyVertexResult(403, { error: { message: "denied" } })).toBe("denied");
    expect(classifyVertexResult(500, { error: { message: "boom" } })).toBe("error");
  });

  it("reads a 400 as unavailable only when the message says so", () => {
    expect(classifyVertexResult(400, { error: { message: "Model is not supported here" } })).toBe(
      "unavailable",
    );
    expect(classifyVertexResult(400, { error: { message: "Invalid JSON payload" } })).toBe("error");
  });

  it("unwraps array-shaped Vertex errors", () => {
    expect(vertexErrorMessage([{ error: { message: "wrapped" } }])).toBe("wrapped");
    expect(vertexErrorMessage({ error: { message: "plain" } })).toBe("plain");
    expect(vertexErrorMessage(null)).toBe("");
  });
});

describe("probeRegionModel", () => {
  const region = { id: "europe-west4", label: "Netherlands" };
  const model = { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" };

  it("returns an available cell with latency and the bearer token attached", async () => {
    let clock = 0;
    const fetchImpl = vi.fn(async () => {
      clock += 120;
      return vertexOk();
    });
    const cell = await probeRegionModel({
      token: "tok",
      project: "p",
      region,
      model,
      fetchImpl,
      now: () => clock,
    });
    expect(cell.verdict).toBe("available");
    expect(cell.latencyMs).toBe(120);
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer tok");
    expect(cell.url).toContain("europe-west4-aiplatform");
  });

  it("sends responseModalities when probing a Flash Image model", async () => {
    const fetchImpl = vi.fn(async () => vertexOk());
    await probeRegionModel({
      token: "t",
      project: "p",
      region,
      model: { id: "gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image" },
      fetchImpl,
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.generationConfig.responseModalities).toEqual(["TEXT", "IMAGE"]);
  });

  it("keeps the API message when a region does not serve the model", async () => {
    const fetchImpl = vi.fn(async () => vertexNotFound(model.id, region.id));
    const cell = await probeRegionModel({ token: "t", project: "p", region, model, fetchImpl });
    expect(cell.verdict).toBe("unavailable");
    expect(cell.status).toBe(404);
    expect(cell.message).toContain("was not found");
  });

  it("resolves on transport failure instead of rejecting", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    const cell = await probeRegionModel({ token: "t", project: "p", region, model, fetchImpl });
    expect(cell.verdict).toBe("error");
    expect(cell.message).toBe("socket hang up");
  });
});

describe("mapWithConcurrency", () => {
  it("never exceeds the limit and preserves input order", async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    const out = await mapWithConcurrency(items, 4, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active -= 1;
      return n * 2;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(out).toEqual(items.map((n) => n * 2));
  });
});

describe("runRegionMatrix", () => {
  it("probes every pair and rolls up available regions per model", async () => {
    const regions = VERTEX_REGIONS.filter((r) => ["eu", "europe-west4"].includes(r.id));
    const models = VERTEX_MODELS.filter((m) =>
      ["gemini-3.7-flash", "gemini-2.5-flash"].includes(m.id),
    );
    // 3.x lives on the eu multi-region only; 2.5 lives in the single region only.
    const fetchImpl = vi.fn(async (url) => {
      const is3x = String(url).includes("gemini-3.7-flash");
      const isEu = String(url).includes("locations/eu/");
      return is3x === isEu ? vertexOk() : vertexNotFound("m", "r");
    });

    const { cells, rollup } = await runRegionMatrix({
      token: "t",
      project: "p",
      regions,
      models,
      fetchImpl,
    });

    expect(cells).toHaveLength(4);
    expect(rollup.find((r) => r.modelId === "gemini-3.7-flash").available).toEqual(["eu"]);
    expect(rollup.find((r) => r.modelId === "gemini-2.5-flash").available).toEqual(["europe-west4"]);
    expect(summarizeMatrix(cells)).toMatchObject({ cells: 4, available: 2, unavailable: 2 });
  });

  it("counts quota hits as available — the model is clearly published there", () => {
    const cells = [{ modelId: "m", regionId: "eu", verdict: "quota" }];
    const rollup = rollupByModel(cells, [{ id: "m", label: "M", family: "3.x" }], [{ id: "eu" }]);
    expect(rollup[0].available).toEqual(["eu"]);
    expect(summarizeMatrix(cells).available).toBe(1);
  });
});

describe("selectByIds", () => {
  it("defaults to EU + global when nothing is requested", () => {
    const picked = selectByIds(undefined, VERTEX_REGIONS, BUILTIN_DEFAULT_REGION_IDS);
    expect(picked.map((r) => r.id)).toEqual(BUILTIN_DEFAULT_REGION_IDS);
    expect(picked.some((r) => r.id === "us-central1")).toBe(false);
  });

  it("filters to the requested ids", () => {
    const picked = selectByIds(["eu", "nope"], VERTEX_REGIONS, BUILTIN_DEFAULT_REGION_IDS);
    expect(picked.map((r) => r.id)).toEqual(["eu"]);
  });
});

describe("env-driven catalogs", () => {
  beforeEach(clearProjectEnv);
  afterEach(clearProjectEnv);

  it("uses the built-in catalogs when nothing is configured", () => {
    expect(resolveProbeRegions()).toEqual(VERTEX_REGIONS);
    expect(resolveProbeModels()).toEqual([...VERTEX_MODELS, ...VERTEX_IMAGE_MODELS]);
    expect(resolveProbeModels().map((m) => m.id)).toEqual(expect.arrayContaining([
      "gemini-3.1-flash-image",
      "gemini-3.1-flash-lite-image",
      "gemini-2.5-flash-image",
    ]));
    expect(resolveVertexChatModels().some((m) => m.id.includes("-image"))).toBe(false);
    expect(resolveDefaultRegionIds()).toEqual(BUILTIN_DEFAULT_REGION_IDS);
    expect(resolveProbeTimeoutMs()).toBe(30000);
    expect(resolveProbeConcurrency()).toBe(8);
  });

  it("narrows both catalogs to the .env lists", () => {
    process.env.VERTEX_PROBE_REGIONS = "eu, europe-west4 ";
    process.env.VERTEX_PROBE_MODELS = "gemini-3.7-flash";
    expect(resolveProbeRegions().map((r) => r.id)).toEqual(["eu", "europe-west4"]);
    expect(resolveProbeModels().map((m) => m.id)).toEqual(["gemini-3.7-flash"]);
    // Default selection follows the configured list, so nothing ticked is off-catalog.
    expect(resolveDefaultRegionIds()).toEqual(["eu", "europe-west4"]);
  });

  it("probes ids it has no label for, so new models need no code change", () => {
    process.env.VERTEX_PROBE_MODELS = "gemini-4-pro,gemini-4-flash-image";
    process.env.VERTEX_PROBE_REGIONS = "europe-west12";
    expect(resolveProbeModels()).toEqual([
      { id: "gemini-4-pro", label: "gemini-4-pro", family: "other" },
      { id: "gemini-4-flash-image", label: "gemini-4-flash-image", family: "image" },
    ]);
    expect(resolveProbeRegions()).toEqual([
      { id: "europe-west12", label: "europe-west12", group: "eu" },
    ]);
  });

  it("lets the default selection differ from the offered list", () => {
    process.env.VERTEX_PROBE_REGIONS = "global,eu,us-central1";
    process.env.VERTEX_PROBE_DEFAULT_REGIONS = "eu";
    expect(resolveDefaultRegionIds()).toEqual(["eu"]);
    expect(resolveProbeRegions()).toHaveLength(3);
  });

  it("groups unknown region ids by prefix", () => {
    expect(inferRegionGroup("global")).toBe("global");
    expect(inferRegionGroup("europe-west12")).toBe("eu");
    expect(inferRegionGroup("us-south1")).toBe("us");
    expect(inferRegionGroup("asia-east2")).toBe("asia");
    expect(inferRegionGroup("me-central1")).toBe("other");
  });

  it("ignores non-positive numeric overrides", () => {
    process.env.VERTEX_PROBE_TIMEOUT_MS = "0";
    process.env.VERTEX_PROBE_CONCURRENCY = "not-a-number";
    expect(resolveProbeTimeoutMs()).toBe(30000);
    expect(resolveProbeConcurrency()).toBe(8);
  });
});

describe("timeouts vs unavailability", () => {
  const region = { id: "europe-west9", label: "Paris" };
  const model = { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" };

  it("marks a hang as timeout, not as 'not served here'", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("The operation was aborted due to timeout");
    });
    const cell = await probeRegionModel({ token: "t", project: "p", region, model, fetchImpl });
    expect(cell.verdict).toBe("timeout");
    expect(summarizeMatrix([cell])).toMatchObject({ timeout: 1, unavailable: 0, available: 0 });
  });

  it("retries a transport error once but not a timeout", async () => {
    const regions = [region];
    const models = [model];
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("socket hang up");
      return vertexOk();
    });
    const { cells } = await runRegionMatrix({
      token: "t",
      project: "p",
      regions,
      models,
      fetchImpl,
    });
    expect(calls).toBe(2);
    expect(cells[0].verdict).toBe("available");
    expect(cells[0].retried).toBe(true);

    const timeoutFetch = vi.fn(async () => {
      throw new Error("The operation was aborted due to timeout");
    });
    const run2 = await runRegionMatrix({
      token: "t",
      project: "p",
      regions,
      models,
      fetchImpl: timeoutFetch,
    });
    expect(timeoutFetch).toHaveBeenCalledTimes(1);
    expect(run2.cells[0].verdict).toBe("timeout");
  });
});

describe("getVertexAccessToken", () => {
  beforeEach(resetVertexTokenCache);
  afterEach(resetVertexTokenCache);

  it("caches the token across calls", async () => {
    const getAccessToken = vi.fn(async () => ({ token: "abc" }));
    const authImpl = { getClient: async () => ({ getAccessToken }) };
    expect(await getVertexAccessToken({ authImpl })).toBe("abc");
    expect(await getVertexAccessToken({ authImpl })).toBe("abc");
    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });

  it("explains how to fix missing credentials", async () => {
    const authImpl = {
      getClient: async () => {
        throw new Error("Could not load the default credentials");
      },
    };
    await expect(getVertexAccessToken({ authImpl })).rejects.toThrow(
      /gcloud auth application-default login/,
    );
  });
});

describe("region probe endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetVertexTokenCache();
    clearProjectEnv();
  });
  afterEach(clearProjectEnv);

  it("GET /api/tests/regions/config exposes the catalog and env project", async () => {
    process.env.GCP_PROJECT = "showgeminibad";
    const res = await request(createApp()).get("/api/tests/regions/config");
    expect(res.status).toBe(200);
    expect(res.body.project).toBe("showgeminibad");
    expect(res.body.projectSource).toBe("env");
    expect(res.body.needsProject).toBe(false);
    expect(res.body.regions.length).toBe(VERTEX_REGIONS.length);
    expect(res.body.defaultRegionIds).toContain("eu");
  });

  it("GET /api/tests/regions/config asks for a project when the env has none", async () => {
    const res = await request(createApp()).get("/api/tests/regions/config");
    expect(res.body.project).toBeNull();
    expect(res.body.needsProject).toBe(true);
  });

  it("POST /api/tests/regions/run rejects when no project is available anywhere", async () => {
    const res = await request(createApp()).post("/api/tests/regions/run").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No Google Cloud project/);
  });
});
