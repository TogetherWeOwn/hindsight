/**
 * Independent SDK-host acceptance tests. Only the Hindsight HTTP boundary is
 * stubbed; events, company-scoped entity reads and tool dispatch use the SDK.
 * These are not a real-backend system story and do not prove backend tenancy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk";
import type { IssueComment, ToolRunContext } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const PREFIX = "paperclip.provenance.";
const NOW = "2026-10-25T14:30:00.000Z";
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

interface RetainedItem {
  content: string;
  document_id?: string;
  timestamp?: string | null;
  metadata?: Record<string, string>;
}
interface HttpCall {
  url: string;
  method: string;
  body: { items?: RetainedItem[]; query?: string; [key: string]: unknown };
}

let calls: HttpCall[];
let recallResults: unknown[];
let retainStatus: number;
let recallStatus: number;

function memory(companyId = RUN.companyId) {
  return {
    id: `memory-${companyId}`,
    document_id: `document-${companyId}-v1`,
    text: `Evidence from ${companyId}`,
    occurred_start: "2025-01-02T03:04:05Z",
    occurred_end: "2025-01-02T04:04:05Z",
    mentioned_at: "2025-01-03T05:06:07Z",
    metadata: {
      companyId,
      agentId: RUN.agentId,
      issueId: "prior-task-not-current",
      runId: "historical-run",
      [`${PREFIX}source_id`]: "historical-comment",
      [`${PREFIX}source_type`]: "issue_comment",
      [`${PREFIX}recorded_at`]: "2025-01-04T00:00:00Z",
      [`${PREFIX}role`]: "agent",
    },
  };
}

function buildHarness(config: Record<string, unknown> = CONFIG) {
  return createTestHarness({
    manifest,
    config,
    capabilities: [...manifest.capabilities, "issues.create", "issue.comments.create"],
  });
}
type Harness = ReturnType<typeof buildHarness>;

async function start(harness: Harness, title = "deployment history", run = RUN) {
  const issue = await harness.ctx.issues.create({
    companyId: run.companyId,
    title,
    assigneeAgentId: run.agentId,
  });
  await harness.emit(
    "agent.run.started",
    { agentId: run.agentId, runId: run.runId, issueId: issue.id },
    { companyId: run.companyId }
  );
  return issue;
}

async function commentFixture(harness: Harness, body = "Full source comment") {
  const issue = await harness.ctx.issues.create({
    companyId: RUN.companyId,
    title: "source task",
    assigneeAgentId: RUN.agentId,
  });
  const comment = await harness.ctx.issues.createComment(issue.id, body, RUN.companyId, {
    authorAgentId: RUN.agentId,
  });
  // Host fixtures deliberately distinguish source times from capture time.
  comment.createdAt = new Date("2024-01-02T03:04:05.000Z");
  comment.updatedAt = new Date("2024-01-03T04:05:06.000Z");
  return { issue, comment };
}

async function emitComment(
  harness: Harness,
  comment: IssueComment,
  payload: Record<string, unknown> = {}
) {
  await harness.emit(
    "issue.comment.created",
    {
      commentId: comment.id,
      agentId: comment.authorAgentId,
      runId: RUN.runId,
      bodySnippet: "Truncated snippet must never replace the raw source",
      ...payload,
    },
    {
      companyId: RUN.companyId,
      entityId: comment.issueId,
      eventId: "delivery-original",
      occurredAt: NOW,
    }
  );
}

function retained(): RetainedItem[] {
  return calls
    .filter((call) => call.url.endsWith("/memories"))
    .flatMap((call) => call.body.items ?? []);
}

function provenance(item: RetainedItem, key: string): string | undefined {
  return item.metadata?.[`${PREFIX}${key}`];
}

function expectImmutableIdentity(item: RetainedItem): void {
  expect(item.document_id).toEqual(expect.any(String));
  expect(item.document_id?.trim().length).toBeGreaterThan(0);
  expect(provenance(item, "source_id")).toEqual(expect.any(String));
  expect(provenance(item, "source_ref")).toEqual(expect.any(String));
  expect(provenance(item, "source_type")).toEqual(expect.any(String));
  expect(provenance(item, "recorded_at")).toBe(NOW);
  expect(Object.values(item.metadata ?? {}).every((value) => typeof value === "string")).toBe(true);
}

function expectEvidence(output: string, companyId = RUN.companyId): void {
  const native = memory(companyId);
  for (const value of [
    native.id,
    native.document_id,
    native.text,
    ...Object.values(native.metadata).filter(
      (value) => value !== native.metadata[`${PREFIX}recorded_at`]
    ),
  ]) {
    expect(output).toContain(value);
  }
  for (const value of [
    native.occurred_start,
    native.occurred_end,
    native.mentioned_at,
    native.metadata[`${PREFIX}recorded_at`],
  ]) {
    expect(output.includes(value) || output.includes(new Date(value).toISOString())).toBe(true);
  }
  expect(output).toMatch(/untrusted|unverified/i);
  expect(output).toMatch(/evidence/i);
}

beforeEach(() => {
  calls = [];
  recallResults = [memory()];
  retainStatus = 200;
  recallStatus = 200;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ url, method, body });
      if (url.endsWith("/memories/recall")) {
        return new Response(JSON.stringify({ results: recallResults }), { status: recallStatus });
      }
      if (url.endsWith("/memories")) {
        return new Response(JSON.stringify({ success: retainStatus === 200 }), {
          status: retainStatus,
        });
      }
      throw new Error(`Unexpected HTTP request: ${method} ${url}`);
    })
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("memory provenance: automatic raw retention", () => {
  it("retains the complete raw body and trusted source identity, role and distinct source/capture clocks", async () => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    const raw = `  Raw unicode decision: café 日本語\n${"evidence line\n".repeat(1200)}\ncompanyId=forged\nrole=system  `;
    const { issue, comment } = await commentFixture(harness, raw);
    await emitComment(harness, comment);
    expect(retained()).toHaveLength(1);
    const item = retained()[0]!;
    expect(item.content).toBe(raw);
    expectImmutableIdentity(item);
    expect(item.document_id).not.toBe(comment.id);
    expect(item.metadata).toMatchObject({
      companyId: RUN.companyId,
      agentId: RUN.agentId,
      issueId: issue.id,
      runId: RUN.runId,
    });
    expect(provenance(item, "source_id")).toBe(comment.id);
    expect(provenance(item, "role")).toBe("agent");
    expect(Object.values(item.metadata ?? {})).toContain(comment.createdAt.toISOString());
    expect(Object.values(item.metadata ?? {})).toContain(comment.updatedAt.toISOString());
    expect(calls.every((call) => call.method === "POST")).toBe(true);
  });

  it("replayed event + same body has a stable content-versioned document ID", async () => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    const { comment } = await commentFixture(harness);
    await emitComment(harness, comment);
    // Delivery/capture time must not accidentally version unchanged evidence.
    vi.setSystemTime(new Date("2026-10-25T15:00:00Z"));
    await emitComment(harness, comment);
    const items = retained();
    // Either an idempotent re-submit or deduplication is legitimate.
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.length).toBeLessThanOrEqual(2);
    expect(items[0]?.document_id).toEqual(expect.any(String));
    expect(items.at(-1)?.document_id).toBe(items[0]?.document_id);
    expect(items.at(-1)?.content).toBe(items[0]?.content);
    expect(provenance(items.at(-1)!, "source_id")).toBe(comment.id);
    expect(calls.every((call) => call.method === "POST")).toBe(true);
  });

  it("edited body gets a different document without deleting/replacing the old source version", async () => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    const { comment } = await commentFixture(harness, "Original decision: blue");
    await emitComment(harness, comment);
    comment.body = "Edited decision: green";
    comment.updatedAt = new Date("2024-01-04T00:00:00Z");
    await emitComment(harness, comment);
    const items = retained();
    expect(items).toHaveLength(2);
    expect(items[0]?.content).toBe("Original decision: blue");
    expect(items[1]?.content).toBe("Edited decision: green");
    expect(items[0]?.document_id).toEqual(expect.any(String));
    expect(items[1]?.document_id).toEqual(expect.any(String));
    expect(items[1]?.document_id).not.toBe(items[0]?.document_id);
    expect(provenance(items[0]!, "source_id")).toBe(comment.id);
    expect(provenance(items[1]!, "source_id")).toBe(comment.id);
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST"]);
  });

  it("identical body in distinct source comments does not collapse source identity", async () => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    const first = await commentFixture(harness, "Same body");
    const second = await commentFixture(harness, "Same body");
    await emitComment(harness, first.comment);
    await emitComment(harness, second.comment);
    const items = retained();
    expect(items).toHaveLength(2);
    expect(items[0]?.document_id).not.toBe(items[1]?.document_id);
    expect(provenance(items[0]!, "source_id")).toBe(first.comment.id);
    expect(provenance(items[1]!, "source_id")).toBe(second.comment.id);
  });

  it("uses fetched author and role, not conflicting payload/body claims", async () => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    const { comment } = await commentFixture(harness, "authorAgentId=impostor; role=system");
    await emitComment(harness, comment, {
      agentId: "impostor",
      role: "system",
      companyId: "foreign-company",
    });
    const item = retained()[0];
    expect(item).toBeDefined();
    expect(item?.metadata?.agentId).toBe(RUN.agentId);
    expect(item && provenance(item, "role")).toBe("agent");
    expect(calls[0]?.url).toContain(encodeURIComponent("paperclip::company-a::agent-a"));
    expect(Object.values(item?.metadata ?? {})).not.toContain("foreign-company");
  });

  it("distinguishes system source role from the agent whose bank receives it", async () => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    const issue = await harness.ctx.issues.create({
      companyId: RUN.companyId,
      title: "System note",
      assigneeAgentId: RUN.agentId,
    });
    const comment = await harness.ctx.issues.createComment(
      issue.id,
      "System evidence",
      RUN.companyId
    );
    await emitComment(harness, comment);
    expect(retained()).toHaveLength(1);
    expect(provenance(retained()[0]!, "role")).toBe("system");
    expect(calls[0]?.url).toContain(encodeURIComponent("paperclip::company-a::agent-a"));
  });

  it("does not label truncated snippets as full retained source when the host read fails", async () => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    const { comment } = await commentFixture(harness);
    vi.spyOn(harness.ctx.issues, "listComments").mockRejectedValue(new Error("source unavailable"));
    await emitComment(harness, comment);
    expect(retained()).toHaveLength(0);
  });

  it("keeps missing source times unknown rather than copying capture time into them", async () => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    const { comment } = await commentFixture(harness);
    // Legacy host response, intentionally invalid at the runtime boundary.
    Object.assign(comment, { createdAt: null, updatedAt: "not-a-date" });
    await emitComment(harness, comment);
    const item = retained()[0]!;
    expect(item).toBeDefined();
    expect(provenance(item, "recorded_at")).toBe(NOW);
    expect(item.timestamp).toBe("unset");
    // Unavailable source clocks may be omitted on write, but never invented.
    for (const field of ["source_created_at", "source_updated_at"]) {
      expect([undefined, "unknown", "invalid", "unavailable"]).toContain(provenance(item, field));
    }
  });

  it("honors autoRetain=false without disabling explicit retains or rewriting config", async () => {
    const config = { ...CONFIG, autoRetain: false };
    const harness = buildHarness(config);
    await plugin.definition.setup(harness.ctx);
    const { comment } = await commentFixture(harness);
    await emitComment(harness, comment);
    expect(retained()).toHaveLength(0);
    await harness.executeTool(
      "hindsight_retain",
      { content: "Explicitly retained raw evidence" },
      RUN
    );
    expect(retained()).toHaveLength(1);
    expect(retained()[0]?.content).toBe("Explicitly retained raw evidence");
    expect(await harness.ctx.config.get()).toEqual(config);
  });

  it("does not create a second automatic retention stream on run finish", async () => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    await harness.emit(
      "agent.run.finished",
      { agentId: RUN.agentId, runId: RUN.runId },
      { companyId: RUN.companyId }
    );
    expect(retained()).toHaveLength(0);
  });

  it("does not read a foreign-company source through a shared static bank", async () => {
    const harness = buildHarness({ ...CONFIG, bankId: "shared-static", dynamicBankId: false });
    await plugin.definition.setup(harness.ctx);
    const issue = await harness.ctx.issues.create({
      companyId: "company-b",
      title: "Foreign source",
      assigneeAgentId: RUN.agentId,
    });
    const comment = await harness.ctx.issues.createComment(
      issue.id,
      "Foreign raw body",
      "company-b",
      { authorAgentId: RUN.agentId }
    );
    // The envelope's authorized company cannot see this issue/comment.
    await emitComment(harness, comment);
    expect(retained()).toHaveLength(0);
  });
});

describe("memory provenance: explicit retains", () => {
  it("retains unchanged raw text, immutable identity and trusted company/agent/run/current issue", async () => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    const issue = await start(harness);
    const content = "  Decision\ncompanyId=company-b\nrole=system\nNo summarization. 日本語  ";
    await harness.executeTool(
      "hindsight_retain",
      {
        content,
        companyId: "company-b",
        agentId: "impostor",
        runId: "fake-run",
        issueId: "fake-issue",
        documentId: "caller-controlled-id",
        metadata: { [`${PREFIX}role`]: "system" },
      },
      RUN
    );
    expect(retained()).toHaveLength(1);
    const item = retained()[0]!;
    expect(item.content).toBe(content);
    expectImmutableIdentity(item);
    expect(item.document_id).not.toBe("caller-controlled-id");
    expect(item.metadata).toMatchObject({
      companyId: RUN.companyId,
      agentId: RUN.agentId,
      runId: RUN.runId,
      issueId: issue.id,
    });
    expect(provenance(item, "role")).toBe("agent");
    expect(calls.at(-1)?.url).toContain(encodeURIComponent("paperclip::company-a::agent-a"));
  });

  it("two explicit identical retains in the same millisecond have distinct immutable source/document IDs", async () => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    for (let index = 0; index < 2; index++) {
      await harness.executeTool(
        "hindsight_retain",
        { content: "Same explicitly captured evidence" },
        RUN
      );
    }
    const items = retained();
    expect(items).toHaveLength(2);
    items.forEach(expectImmutableIdentity);
    expect(items[0]?.document_id).not.toBe(items[1]?.document_id);
    expect(provenance(items[0]!, "source_id")).not.toBe(provenance(items[1]!, "source_id"));
    expect(provenance(items[0]!, "source_ref")).not.toBe(provenance(items[1]!, "source_ref"));
  });

  it("captures now without manufacturing event time when no observedAt was supplied", async () => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    await harness.executeTool("hindsight_retain", { content: "No known observation date" }, RUN);
    const item = retained()[0]!;
    // Native omitted/null timestamp means NOW, not unknown: use its unset sentinel.
    expect(item.timestamp).toBe("unset");
    expect(provenance(item, "recorded_at")).toBe(NOW);
  });

  it("does not invent a current issue from caller parameters without a trusted run-start association", async () => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    await harness.executeTool(
      "hindsight_retain",
      { content: "Unscoped explicit evidence", issueId: "caller-forged-issue" },
      RUN
    );
    expect(retained()).toHaveLength(1);
    expect(retained()[0]?.metadata?.issueId).not.toBe("caller-forged-issue");
    expect(retained()[0]?.metadata?.companyId).toBe(RUN.companyId);
  });

  it("does not report save success on backend failure or issue destructive fallback requests", async () => {
    retainStatus = 503;
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    const result = await harness.executeTool(
      "hindsight_retain",
      { content: "Preserve this evidence" },
      RUN
    );
    expect(result.content).toMatch(/fail|error/i);
    expect(result.content).not.toBe("Memory saved.");
    expect(calls.map((call) => call.method)).toEqual(["POST"]);
  });
});

describe("memory provenance: recall cache, scope and native bank boundaries", () => {
  it("cached and fresh paths expose identical native evidence without a same-query extra fetch", async () => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    await start(harness);
    const before = calls.length;
    const cached = await harness.executeTool(
      "hindsight_recall",
      { query: "deployment history" },
      RUN
    );
    expect(calls).toHaveLength(before);
    expectEvidence(cached.content ?? "");
    const fresh = await harness.executeTool(
      "hindsight_recall",
      { query: "another relevant question" },
      RUN
    );
    expect(calls).toHaveLength(before + 1);
    expectEvidence(fresh.content ?? "");
    expect(cached.content).toBe(fresh.content);
  });

  it.each([{ companyId: "company-b" }, { agentId: "agent-b" }])(
    "does not reuse same-run/same-query cache after trusted context changes: %j",
    async (change) => {
      const harness = buildHarness();
      await plugin.definition.setup(harness.ctx);
      await start(harness);
      recallResults = [{ text: "Fresh evidence for changed trusted scope" }];
      const nextRun = { ...RUN, ...change };
      const result = await harness.executeTool(
        "hindsight_recall",
        { query: "deployment history" },
        nextRun
      );
      expect(calls).toHaveLength(2);
      expect(result.content).toContain("Fresh evidence for changed trusted scope");
      expect(result.content).not.toContain("Evidence from company-a");
      expect(calls.at(-1)?.url).toContain(
        encodeURIComponent(`paperclip::${nextRun.companyId}::${nextRun.agentId}`)
      );
    }
  );

  it("does not reuse cache after a static-bank configuration change", async () => {
    const harness = buildHarness({ ...CONFIG, bankId: "static-bank-before", dynamicBankId: false });
    await plugin.definition.setup(harness.ctx);
    await start(harness);
    harness.setConfig({ ...CONFIG, bankId: "static-bank-after", dynamicBankId: false });
    recallResults = [{ text: "Evidence from replacement configured bank" }];
    const result = await harness.executeTool(
      "hindsight_recall",
      { query: "deployment history" },
      RUN
    );
    expect(calls).toHaveLength(2);
    expect(calls.at(-1)?.url).toContain(encodeURIComponent("static-bank-after"));
    expect(result.content).toContain("Evidence from replacement configured bank");
    expect(result.content).not.toContain("Evidence from company-a");
  });

  it("does not reuse cache after the configured backend origin changes", async () => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    await start(harness);
    harness.setConfig({ ...CONFIG, hindsightApiUrl: "https://replacement-backend.invalid" });
    recallResults = [{ text: "Evidence from replacement backend" }];
    const result = await harness.executeTool(
      "hindsight_recall",
      { query: "deployment history" },
      RUN
    );
    expect(calls).toHaveLength(2);
    expect(calls.at(-1)?.url).toMatch(/^https:\/\/replacement-backend\.invalid\//);
    expect(result.content).toContain("Evidence from replacement backend");
    expect(result.content).not.toContain("Evidence from company-a");
  });

  it("does not reuse cache after a configured secret reference changes backend identity", async () => {
    const firstRef = { type: "secret_ref", secretId: "fixture-reference-a" };
    const nextRef = { type: "secret_ref", secretId: "fixture-reference-b" };
    const harness = buildHarness({ ...CONFIG, hindsightApiKeyRef: firstRef });
    const resolve = vi
      .spyOn(harness.ctx.secrets, "resolve")
      .mockResolvedValue("synthetic-test-only-key");
    await plugin.definition.setup(harness.ctx);
    await start(harness);
    harness.setConfig({ ...CONFIG, hindsightApiKeyRef: nextRef });
    recallResults = [{ text: "Evidence from new authenticated backend identity" }];
    const result = await harness.executeTool(
      "hindsight_recall",
      { query: "deployment history" },
      RUN
    );
    expect(calls).toHaveLength(2);
    expect(resolve).toHaveBeenLastCalledWith(nextRef, {
      companyId: RUN.companyId,
      configPath: "hindsightApiKeyRef",
    });
    expect(result.content).toContain("Evidence from new authenticated backend identity");
    expect(result.content).not.toContain("Evidence from company-a");
  });

  it("resolves configured credentials for each fresh HTTP operation without credential caching", async () => {
    const reference = { type: "secret_ref", secretId: "fixture-reference" };
    const harness = buildHarness({ ...CONFIG, hindsightApiKeyRef: reference });
    const resolve = vi
      .spyOn(harness.ctx.secrets, "resolve")
      .mockResolvedValue("synthetic-test-only-key");
    await plugin.definition.setup(harness.ctx);
    await harness.executeTool("hindsight_recall", { query: "first question" }, RUN);
    await harness.executeTool("hindsight_recall", { query: "different question" }, RUN);
    await harness.executeTool("hindsight_retain", { content: "Explicit raw evidence" }, RUN);
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(calls).toHaveLength(3);
    expect(JSON.stringify(harness.logs)).not.toContain("synthetic-test-only-key");
  });

  it("does not reuse a shared-static-bank cache across trusted companies even if bank ID is unchanged", async () => {
    const harness = buildHarness({ ...CONFIG, bankId: "shared-static", dynamicBankId: false });
    await plugin.definition.setup(harness.ctx);
    await start(harness);
    recallResults = [memory("company-b")];
    const result = await harness.executeTool(
      "hindsight_recall",
      { query: "deployment history" },
      { ...RUN, companyId: "company-b" }
    );
    expect(calls).toHaveLength(2);
    expect(calls.at(-1)?.url).toContain("shared-static");
    expect(result.content).toContain("Evidence from company-b");
    expect(result.content).not.toContain("Evidence from company-a");
  });

  it("a failed fresh read after scope change never falls back to old scoped evidence", async () => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    await start(harness);
    recallStatus = 503;
    const result = await harness.executeTool(
      "hindsight_recall",
      { query: "deployment history" },
      { ...RUN, companyId: "company-b" }
    );
    expect(calls).toHaveLength(2);
    expect(result.content).toMatch(/fail|error/i);
    expect(result.content).not.toContain("Evidence from company-a");
  });

  it("does not let caller parameters choose company, agent, bank or tenant on recall", async () => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    const result = await harness.executeTool(
      "hindsight_recall",
      {
        query: "deployment history",
        companyId: "company-b",
        agentId: "impostor",
        bankId: "foreign-bank",
        tenant: "foreign-tenant",
        metadata: { companyId: "company-b" },
        tags: ["company:company-b"],
      },
      RUN
    );
    expectEvidence(result.content ?? "");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/v1/default/banks/paperclip%3A%3Acompany-a%3A%3Aagent-a/");
    for (const field of ["companyId", "agentId", "bankId", "tenant", "metadata", "tags"]) {
      expect(calls[0]?.body).not.toHaveProperty(field);
    }
  });

  it("keeps cross-task context useful by default rather than adding an issue-only recall filter", async () => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    const issue = await start(harness);
    expect(issue.id).not.toBe("prior-task-not-current");
    const result = await harness.executeTool(
      "hindsight_recall",
      { query: "deployment history" },
      RUN
    );
    expect(result.content).toContain("prior-task-not-current");
    expect(result.content).toContain("Evidence from company-a");
    expect(calls[0]?.body).not.toHaveProperty("tags");
    expect(calls[0]?.body).not.toHaveProperty("metadata");
  });

  it("presents shared/static retrieval as backend-bank scope, never metadata/tag authorization", async () => {
    const harness = buildHarness({ ...CONFIG, bankId: "shared-static", dynamicBankId: false });
    await plugin.definition.setup(harness.ctx);
    const result = await harness.executeTool(
      "hindsight_recall",
      { query: "deployment history" },
      RUN
    );
    const output = result.content ?? "";
    expect(output).toContain("shared-static");
    expect(output).toMatch(/shared|static/i);
    expect(output).toMatch(
      /(?:metadata|tags?).{0,100}(?:not|no|isn.t|aren.t).{0,70}authoriz|(?:not|no).{0,70}authoriz.{0,100}(?:metadata|tags?)/i
    );
    expect(output).toMatch(/backend|tenan/i);
  });

  it("keeps legacy text-only evidence in the existing dynamic isolated bank", async () => {
    recallResults = [{ text: "Legacy cross-task preference" }];
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    const result = await harness.executeTool("hindsight_recall", { query: "preference" }, RUN);
    expect(result.content).toContain("Legacy cross-task preference");
    expect(calls[0]?.url).toContain(encodeURIComponent("paperclip::company-a::agent-a"));
    expect(result.content).toMatch(/unknown/i);
    expect(result.content).toMatch(/untrusted|unverified/i);
  });

  it("clears obsolete per-user attribution when a later trusted run-start has no user", async () => {
    const harness = buildHarness({ ...CONFIG, bankGranularity: ["company", "agent", "user"] });
    await plugin.definition.setup(harness.ctx);
    const issue = await harness.ctx.issues.create({
      companyId: RUN.companyId,
      title: "deployment history",
      assigneeAgentId: RUN.agentId,
    });
    Object.assign(issue, { originId: "slack::alice@example.test" });
    await harness.emit(
      "agent.run.started",
      { agentId: RUN.agentId, runId: RUN.runId, issueId: issue.id },
      { companyId: RUN.companyId }
    );
    expect(calls[0]?.url).toContain(
      encodeURIComponent("paperclip::company-a::agent-a::user::alice@example.test")
    );
    const withoutUser = await harness.ctx.issues.create({
      companyId: RUN.companyId,
      title: "deployment history",
      assigneeAgentId: RUN.agentId,
    });
    await harness.emit(
      "agent.run.started",
      { agentId: RUN.agentId, runId: RUN.runId, issueId: withoutUser.id },
      { companyId: RUN.companyId }
    );
    await harness.executeTool(
      "hindsight_retain",
      { content: "No user-scoped source on this task" },
      RUN
    );
    expect(calls.at(-1)?.url).toContain("/banks/paperclip%3A%3Acompany-a%3A%3Aagent-a/memories");
    expect(calls.at(-1)?.url).not.toContain(encodeURIComponent("alice@example.test"));
  });
});
