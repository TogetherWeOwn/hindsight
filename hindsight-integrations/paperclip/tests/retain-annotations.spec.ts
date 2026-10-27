/** Optional annotations are claims about raw episodes, never caller authority. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const PREFIX = "paperclip.provenance.";
const NOW = "2026-10-25T14:30:00.000Z";
const RUN: ToolRunContext = {
  companyId: "company-a",
  agentId: "agent-a",
  runId: "run-a",
  projectId: "project-a",
};

interface RetainedItem {
  content: string;
  document_id?: string;
  timestamp?: string | null;
  metadata?: Record<string, string>;
}
interface HttpCall {
  url: string;
  method: string;
  body: { items?: RetainedItem[]; [key: string]: unknown };
}

let calls: HttpCall[];

function buildHarness() {
  return createTestHarness({
    manifest,
    config: {
      hindsightApiUrl: "https://hindsight.invalid",
      bankGranularity: ["company", "agent"],
      recallBudget: "mid",
      autoRetain: true,
    },
    capabilities: [...manifest.capabilities, "issues.create", "issue.comments.create"],
  });
}

function retained(): RetainedItem[] {
  return calls.flatMap((call) => call.body.items ?? []);
}

beforeEach(() => {
  calls = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: HttpCall = {
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : {},
      };
      calls.push(call);
      if (call.method !== "POST" || !call.url.endsWith("/memories")) {
        throw new Error(`Unexpected HTTP request: ${call.method} ${call.url}`);
      }
      return new Response(JSON.stringify({ success: true }));
    })
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("optional raw-retain annotations", () => {
  it("discovers only content and optional annotations, never caller-selected identity or scope", () => {
    const schema = manifest.tools!.find(
      (tool) => tool.name === "hindsight_retain"
    )!.parametersSchema;
    expect(schema.required).toEqual(["content"]);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      "content",
      "observedAt",
      "supersedes",
      "validUntil",
    ]);
    for (const name of ["observedAt", "validUntil", "supersedes"]) {
      expect(schema.properties?.[name]).toMatchObject({ type: "string" });
    }
  });

  it.each(["2024-02-29T10:00:00Z", "2024-02-29T10:00:00+05:30"])(
    "maps qualified observedAt %s to native timestamp without replacing capture time",
    async (observedAt) => {
      const harness = buildHarness();
      await plugin.definition.setup(harness.ctx);
      const result = await harness.executeTool(
        "hindsight_retain",
        { content: "Exact raw observation. 日本語", observedAt },
        RUN
      );
      expect(result.content).toMatch(/saved/i);
      expect(retained()).toHaveLength(1);
      const item = retained()[0]!;
      expect(item.content).toBe("Exact raw observation. 日本語");
      expect(item.timestamp).toEqual(expect.any(String));
      expect(new Date(item.timestamp!).toISOString()).toBe(new Date(observedAt).toISOString());
      expect(item.metadata?.[`${PREFIX}recorded_at`]).toBe(NOW);
    }
  );

  it("stores validUntil and supersedes as additive provenance claims, not native validity or authority", async () => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    await harness.executeTool("hindsight_retain", { content: "Prior raw decision: blue" }, RUN);
    expect(retained()).toHaveLength(1);
    const prior = structuredClone(retained()[0]!);
    expect(prior.document_id).toEqual(expect.any(String));
    expect(prior.document_id?.trim().length).toBeGreaterThan(0);

    const validUntil = "2030-01-01T00:00:00+02:00";
    const result = await harness.executeTool(
      "hindsight_retain",
      {
        content: "Later raw decision: green; this is a claim, not a deletion instruction.",
        validUntil,
        supersedes: prior.document_id,
        companyId: "forged-company",
        bankId: "forged-bank",
        documentId: prior.document_id,
      },
      RUN
    );
    expect(result.content).toMatch(/saved/i);
    const items = retained();
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual(prior);
    expect(items[1]?.content).toBe(
      "Later raw decision: green; this is a claim, not a deletion instruction."
    );
    expect(items[1]?.document_id).toEqual(expect.any(String));
    expect(items[1]?.document_id).not.toBe(prior.document_id);
    expect(items[1]?.timestamp).toBe("unset");
    expect(items[1]?.metadata?.[`${PREFIX}supersedes`]).toBe(prior.document_id);
    const claim = items[1]?.metadata?.[`${PREFIX}valid_until`];
    expect(claim).toEqual(expect.any(String));
    expect(new Date(claim!).toISOString()).toBe(new Date(validUntil).toISOString());
    expect(items[1]?.metadata).toMatchObject({ companyId: RUN.companyId, agentId: RUN.agentId });
    expect(
      Object.values(items[1]?.metadata ?? {}).every((value) => typeof value === "string")
    ).toBe(true);
    for (const field of ["validUntil", "valid_until", "supersedes", "companyId", "bankId"]) {
      expect(items[1]).not.toHaveProperty(field);
      expect(calls[1]?.body).not.toHaveProperty(field);
    }
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST"]);
    expect(
      calls.every((call) => call.url.includes("/banks/paperclip%3A%3Acompany-a%3A%3Aagent-a/"))
    ).toBe(true);
  });

  it("refreshes a run-start recall after an annotated retain instead of hiding new evidence behind cache", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/memories/recall")) {
        return new Response(JSON.stringify({ results: [{ text: "Deployment evidence" }] }));
      }
      if (url.endsWith("/memories") && init?.method === "POST") {
        return new Response(JSON.stringify({ success: true }));
      }
      throw new Error(`Unexpected HTTP request: ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    const issue = await harness.ctx.issues.create({
      companyId: RUN.companyId,
      title: "deployment history",
      assigneeAgentId: RUN.agentId,
    });
    await harness.emit(
      "agent.run.started",
      { agentId: RUN.agentId, runId: RUN.runId, issueId: issue.id },
      { companyId: RUN.companyId }
    );
    await harness.executeTool("hindsight_recall", { query: "deployment history" }, RUN);
    expect(fetch).toHaveBeenCalledTimes(1);
    const result = await harness.executeTool(
      "hindsight_retain",
      { content: "New claimed supersession evidence", supersedes: "earlier-document" },
      RUN
    );
    expect(result.content).toMatch(/saved/i);
    await harness.executeTool("hindsight_recall", { query: "deployment history" }, RUN);
    expect(fetch.mock.calls.map(([url]) => String(url).split("/memories")[1])).toEqual([
      "/recall",
      "",
      "/recall",
    ]);
  });

  it("keeps legacy content-only calls valid and event time unknown", async () => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    const result = await harness.executeTool(
      "hindsight_retain",
      { content: "  Original raw text\n  " },
      RUN
    );
    expect(result.content).toMatch(/saved/i);
    expect(retained()).toHaveLength(1);
    const item = retained()[0]!;
    expect(item.content).toBe("  Original raw text\n  ");
    expect(item.timestamp).toBe("unset");
    expect(item.metadata?.[`${PREFIX}recorded_at`]).toBe(NOW);
    expect(item.metadata).not.toHaveProperty(`${PREFIX}valid_until`);
    expect(item.metadata).not.toHaveProperty(`${PREFIX}supersedes`);
  });

  describe.each(["observedAt", "validUntil"])("invalid %s", (field) => {
    it.each([
      "not-a-date",
      "2025-02-29T10:00:00Z",
      "2024-02-30T10:00:00Z",
      "2024-04-31T10:00:00Z",
      "2024-01-01T10:00:00",
      "2024-01-01",
      "2024-01-01T24:00:00Z",
      "2024-01-01T10:00:00+25:00",
      "",
      1234567890,
    ])("rejects %j before HTTP without claiming save success", async (invalid) => {
      const harness = buildHarness();
      await plugin.definition.setup(harness.ctx);
      const result = await harness.executeTool(
        "hindsight_retain",
        { content: "Do not silently save with a substituted timestamp", [field]: invalid },
        RUN
      );
      expect(result.content).toMatch(/invalid|fail|error/i);
      expect(result.content).not.toMatch(/memory saved/i);
      expect(calls).toEqual([]);
    });
  });

  it("keeps invalid fetched Date objects unknown without dropping the raw automatic episode", async () => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    const issue = await harness.ctx.issues.create({
      companyId: RUN.companyId,
      title: "Legacy invalid source clocks",
      assigneeAgentId: RUN.agentId,
    });
    const comment = await harness.ctx.issues.createComment(
      issue.id,
      "Full original raw comment",
      RUN.companyId,
      {
        authorAgentId: RUN.agentId,
      }
    );
    comment.createdAt = new Date("invalid");
    comment.updatedAt = new Date("invalid");
    await harness.emit(
      "issue.comment.created",
      { commentId: comment.id, agentId: RUN.agentId, runId: RUN.runId },
      { companyId: RUN.companyId, entityId: issue.id }
    );
    expect(retained()).toHaveLength(1);
    const item = retained()[0]!;
    expect(item.content).toBe("Full original raw comment");
    expect(item.timestamp).toBe("unset");
    expect(item.metadata?.[`${PREFIX}recorded_at`]).toBe(NOW);
    for (const key of ["source_created_at", "source_updated_at"]) {
      expect([undefined, "unknown", "invalid", "unavailable"]).toContain(
        item.metadata?.[`${PREFIX}${key}`]
      );
    }
  });
});
