/**
 * Pins the PR's documented guards so deleting one fails the suite: run-start
 * state reset, fetched-comment scope match, retain input validation and the
 * recall-cache bindings. Only the Hindsight HTTP boundary is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const CONFIG = {
  hindsightApiUrl: "https://hindsight.invalid",
  bankGranularity: ["company", "agent"],
  recallBudget: "mid",
  autoRetain: true,
};
const RUN: ToolRunContext = {
  companyId: "company-a",
  agentId: "agent-a",
  runId: "run-a",
  projectId: "project-a",
};

let urls: string[];
let recallBodies: Array<Record<string, unknown>>;

function buildHarness(config: Record<string, unknown> = CONFIG) {
  return createTestHarness({
    manifest,
    config,
    capabilities: [...manifest.capabilities, "issues.create", "issue.comments.create"],
  });
}
type Harness = ReturnType<typeof buildHarness>;

const attributionKey = {
  scopeKind: "run" as const,
  scopeId: RUN.runId,
  stateKey: "memory-attribution",
};

function retainCalls(): string[] {
  return urls.filter((url) => url.endsWith("/memories"));
}

beforeEach(() => {
  urls = [];
  recallBodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/memories/recall")) {
        recallBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ results: [{ text: "Live evidence" }] }));
      }
      return new Response(JSON.stringify({ success: true }));
    })
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("run-start state reset", () => {
  it("clears a reused run's prior attribution and user before an early return", async () => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    await harness.ctx.state.set(attributionKey, {
      companyId: RUN.companyId,
      agentId: RUN.agentId,
      issueId: "previous-issue",
      userId: "previous-user",
    });
    await harness.ctx.state.set({ ...attributionKey, stateKey: "user-id" }, "previous-user");
    // No issueId: the handler returns early after the reset.
    await harness.emit(
      "agent.run.started",
      { agentId: RUN.agentId, runId: RUN.runId },
      { companyId: RUN.companyId }
    );
    expect(await harness.ctx.state.get(attributionKey)).toBeNull();
    expect(await harness.ctx.state.get({ ...attributionKey, stateKey: "user-id" })).toBeNull();
  });
});

describe("fetched comment scope match", () => {
  const cases: Array<[string, Record<string, string>]> = [
    ["another company", { companyId: "company-b" }],
    ["another issue", { issueId: "other-issue" }],
  ];
  it.each(cases)("does not retain a comment id that belongs to %s", async (_label, override) => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    const issue = await harness.ctx.issues.create({
      companyId: RUN.companyId,
      title: "source task",
      assigneeAgentId: RUN.agentId,
    });
    const comment = await harness.ctx.issues.createComment(issue.id, "Body", RUN.companyId, {
      authorAgentId: RUN.agentId,
    });
    harness.ctx.issues.listComments = async () => [{ ...comment, ...override }];
    await harness.emit(
      "issue.comment.created",
      { commentId: comment.id, agentId: RUN.agentId, runId: RUN.runId },
      { companyId: RUN.companyId, entityId: issue.id }
    );
    expect(retainCalls()).toEqual([]);
  });
});

describe("retain input validation", () => {
  it.each([undefined, "", "   ", 7, null])("rejects content %j before HTTP", async (content) => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    const result = await harness.executeTool("hindsight_retain", { content }, RUN);
    expect(result.error).toBe("invalid-content");
    expect(urls).toEqual([]);
  });

  it.each(["", "   ", "x".repeat(513), 7, {}])(
    "rejects supersedes %j before HTTP",
    async (supersedes) => {
      const harness = buildHarness();
      await plugin.definition.setup(harness.ctx);
      const result = await harness.executeTool(
        "hindsight_retain",
        { content: "Valid body", supersedes },
        RUN
      );
      expect(result.error).toBe("invalid-supersedes");
      expect(urls).toEqual([]);
    }
  );

  it("accepts the 512-character supersedes boundary", async () => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    const result = await harness.executeTool(
      "hindsight_retain",
      { content: "Valid body", supersedes: "x".repeat(512) },
      RUN
    );
    expect(result.error).toBeUndefined();
    expect(retainCalls()).toHaveLength(1);
  });

  it("treats null annotations as absent instead of dropping the retain", async () => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    const result = await harness.executeTool(
      "hindsight_retain",
      { content: "Valid body", observedAt: null, validUntil: null, supersedes: null },
      RUN
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toMatch(/saved/i);
    expect(retainCalls()).toHaveLength(1);
  });
});

describe("recall cache bindings", () => {
  async function startWithCachedRecall(harness: Harness) {
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
    expect(recallBodies).toHaveLength(1);
  }

  it("serves the matching cached recall without a second backend read", async () => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    await startWithCachedRecall(harness);
    await harness.executeTool("hindsight_recall", { query: "deployment history" }, RUN);
    expect(recallBodies).toHaveLength(1);
  });

  it("ignores a cache stored by a different agent even when the bank is shared", async () => {
    const harness = buildHarness({ ...CONFIG, bankGranularity: ["company"] });
    await plugin.definition.setup(harness.ctx);
    const issue = await harness.ctx.issues.create({
      companyId: RUN.companyId,
      title: "deployment history",
      assigneeAgentId: "agent-b",
    });
    // The same run id was started by another agent against the same bank.
    await harness.emit(
      "agent.run.started",
      { agentId: "agent-b", runId: RUN.runId, issueId: issue.id },
      { companyId: RUN.companyId }
    );
    expect(recallBodies).toHaveLength(1);
    await harness.executeTool("hindsight_recall", { query: "deployment history" }, RUN);
    expect(recallBodies).toHaveLength(2);
  });

  it("does not reuse a cache built under a different recall budget", async () => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    await startWithCachedRecall(harness);
    harness.ctx.config.get = async () => ({ ...CONFIG, recallBudget: "high" });
    await harness.executeTool("hindsight_recall", { query: "deployment history" }, RUN);
    expect(recallBodies).toHaveLength(2);
    expect(recallBodies[1]?.budget).toBe("high");
  });
});
