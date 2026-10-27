/**
 * Independent acceptance regression for TOG-41174: a reverted source edit must
 * not overwrite the original revision's temporal capture bundle.
 *
 * Only the Hindsight HTTP boundary is stubbed; events, company-scoped entity
 * reads and tool dispatch use the SDK harness. This is not a real-backend
 * system story and does not prove backend tenancy.
 *
 * Contract: the adapter versions a comment revision by trusted SOURCE identity
 * + bytes + SOURCE revision clock (fetched comment.updatedAt), never by
 * capture/recorded_at time. A source edited A→B→A with a trusted updatedAt
 * bump on each edit must yield three distinct document IDs sharing one
 * original source_id; a pure redelivery (same body, same source.updatedAt,
 * only capture Date changed) stays idempotent — see the untouched
 * "replayed event + same body" case in memory-provenance-paths.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk";
import type { IssueComment, ToolRunContext } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const PREFIX = "paperclip.provenance.";
const CAPTURE_V1 = "2026-10-25T14:30:00.000Z";
const CAPTURE_V2 = "2026-10-25T14:35:00.000Z";
const CAPTURE_V3 = "2026-10-25T14:40:00.000Z";
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
  body: { items?: RetainedItem[]; [key: string]: unknown };
}

let calls: HttpCall[];

function buildHarness(config: Record<string, unknown> = CONFIG) {
  return createTestHarness({
    manifest,
    config,
    capabilities: [...manifest.capabilities, "issues.create", "issue.comments.create"],
  });
}
type Harness = ReturnType<typeof buildHarness>;

async function commentFixture(harness: Harness, body: string) {
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

async function emitComment(harness: Harness, comment: IssueComment) {
  await harness.emit(
    "issue.comment.created",
    {
      commentId: comment.id,
      agentId: comment.authorAgentId,
      runId: RUN.runId,
      bodySnippet: "Truncated snippet must never replace the raw source",
    },
    {
      companyId: RUN.companyId,
      entityId: comment.issueId,
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

beforeEach(() => {
  calls = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(CAPTURE_V1));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ url, method, body });
      if (url.endsWith("/memories")) {
        return new Response(JSON.stringify({ success: true }));
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

describe("reverted revision provenance: A→B→A keeps distinct source revisions", () => {
  it("assigns three distinct document IDs to A→B→A with distinct source updatedAt, sharing one source_id", async () => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    const bodyA = "Original decision: blue — full raw bytes café 日本語";
    const bodyB = "Edited decision: green — full raw bytes";
    const { comment } = await commentFixture(harness, bodyA);

    const sourceV1 = comment.updatedAt.toISOString();
    await emitComment(harness, comment);

    comment.body = bodyB;
    comment.updatedAt = new Date("2024-01-04T00:00:00.000Z");
    const sourceV2 = comment.updatedAt.toISOString();
    vi.setSystemTime(new Date(CAPTURE_V2));
    await emitComment(harness, comment);

    // Revert to the exact original bytes with a fresh trusted source clock.
    comment.body = bodyA;
    comment.updatedAt = new Date("2024-01-05T00:00:00.000Z");
    const sourceV3 = comment.updatedAt.toISOString();
    vi.setSystemTime(new Date(CAPTURE_V3));
    await emitComment(harness, comment);

    const items = retained();
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.content)).toEqual([bodyA, bodyB, bodyA]);

    // The reverted revision must not reuse the original revision's document
    // ID: identical-content retain would otherwise overwrite the original
    // temporal capture bundle while raw bytes survive.
    const documentIds = items.map((item) => item.document_id);
    for (const documentId of documentIds) {
      expect(documentId).toEqual(expect.any(String));
      expect(documentId?.trim().length).toBeGreaterThan(0);
    }
    expect(new Set(documentIds).size).toBe(3);

    // One original source, three revisions.
    for (const item of items) {
      expect(provenance(item, "source_id")).toBe(comment.id);
    }

    // Each revision carries its own trusted source clock and capture bundle.
    const updatedAts = items.map((item) => provenance(item, "source_updated_at"));
    expect(updatedAts).toEqual([sourceV1, sourceV2, sourceV3]);
    expect(new Set(updatedAts).size).toBe(3);
    const recordedAts = items.map((item) => provenance(item, "recorded_at"));
    expect(recordedAts).toEqual([CAPTURE_V1, CAPTURE_V2, CAPTURE_V3]);
    const sourceRefs = items.map((item) => provenance(item, "source_ref"));
    expect(new Set(sourceRefs).size).toBe(3);
    expect(items.map((item) => item.timestamp)).toEqual([sourceV1, sourceV2, sourceV3]);
    expect(calls.every((call) => call.method === "POST")).toBe(true);
  });

  it("falls back to a stable content-versioned identity when the source clock is unknown", async () => {
    const harness = buildHarness();
    await plugin.definition.setup(harness.ctx);
    const { comment } = await commentFixture(harness, "Same legacy body");
    // Legacy host response, intentionally invalid at the runtime boundary.
    Object.assign(comment, { createdAt: null, updatedAt: "not-a-date" });

    await emitComment(harness, comment);
    // Capture/redelivery time must not accidentally version unchanged evidence.
    vi.setSystemTime(new Date(CAPTURE_V2));
    await emitComment(harness, comment);

    const items = retained();
    expect(items).toHaveLength(2);
    expect(items[0]?.content).toBe("Same legacy body");
    expect(items[1]?.content).toBe("Same legacy body");
    // Without a trusted source clock there is nothing to distinguish the two
    // deliveries: the fallback stays idempotent instead of crashing or
    // forking a new revision per capture.
    expect(items[0]?.document_id).toEqual(expect.any(String));
    expect(items[1]?.document_id).toBe(items[0]?.document_id);
    expect(provenance(items[0]!, "source_id")).toBe(comment.id);
    expect(provenance(items[1]!, "source_id")).toBe(comment.id);
    for (const item of items) {
      expect(item.timestamp).toBe("unset");
      expect([undefined, "unknown", "invalid", "unavailable"]).toContain(
        provenance(item, "source_updated_at")
      );
    }
    expect(calls.every((call) => call.method === "POST")).toBe(true);
  });
});
