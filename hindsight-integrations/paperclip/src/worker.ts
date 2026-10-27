/**
 * paperclip-plugin-hindsight — worker entrypoint.
 *
 * Gives Paperclip agents persistent long-term memory via Hindsight.
 *
 * Lifecycle:
 *   agent.run.started      → fetch the run's issue, recall relevant memories,
 *                            cache them in plugin state for the run.
 *   issue.comment.created  → retain the full comment body to Hindsight (this is
 *                            the durable signal — it covers both user comments
 *                            and agent-authored comments).
 *   agent.run.finished     → no-op (Paperclip's lifecycle payload does not
 *                            carry run output; subscription kept for future use).
 *
 * Agent tools (callable mid-run):
 *   hindsight_recall(query)   → search memory, returns relevant context
 *   hindsight_retain(content) → store content in memory immediately
 */

import { createHash, randomUUID } from "node:crypto";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { EnvSecretRefBinding, PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { HindsightClient, formatMemories, formatTimestamp } from "./client.js";
import { deriveBankId, extractUserFromIssue } from "./bank.js";
import { retainParametersSchema } from "./manifest.js";

interface PluginConfig {
  hindsightApiUrl: string;
  /**
   * Reference stored by the host's secret picker for the `format: "secret-ref"`
   * field. The host fails closed on a bare string, so it travels through as-is.
   */
  hindsightApiKeyRef?: EnvSecretRefBinding;
  bankId?: string;
  dynamicBankId?: boolean;
  bankGranularity?: Array<"company" | "agent" | "user">;
  recallBudget?: "low" | "mid" | "high";
  requestTimeoutMs?: number;
  autoRetain?: boolean;
  enabledAgentIds?: string[];
}

interface RunAttribution {
  companyId: string;
  agentId: string;
  issueId: string;
  userId?: string;
  recall?: { query: string; scope: string; memories: string };
}

async function readRunAttribution(
  ctx: PluginContext,
  run: ToolRunContext
): Promise<RunAttribution | undefined> {
  const stored = await ctx.state.get({
    scopeKind: "run",
    scopeId: run.runId,
    stateKey: "memory-attribution",
  });
  if (!stored || typeof stored !== "object") return undefined;
  const value = stored as Partial<RunAttribution>;
  if (
    value.companyId !== run.companyId ||
    value.agentId !== run.agentId ||
    typeof value.issueId !== "string"
  ) {
    return undefined;
  }
  return {
    companyId: value.companyId,
    agentId: value.agentId,
    issueId: value.issueId,
    userId: typeof value.userId === "string" ? value.userId : undefined,
    recall:
      value.recall &&
      typeof value.recall.query === "string" &&
      typeof value.recall.scope === "string" &&
      typeof value.recall.memories === "string"
        ? value.recall
        : undefined,
  };
}

function recallScope(config: PluginConfig, bankId: string, attribution?: RunAttribution): string {
  // Only binding identity is fingerprinted, never a resolved credential. A
  // config/principal change must not reuse evidence from a different backend.
  return createHash("sha256")
    .update(
      JSON.stringify({
        origin: config.hindsightApiUrl.trim().replace(/\/$/, ""),
        secretRef: config.hindsightApiKeyRef ?? null,
        bankId,
        budget: config.recallBudget ?? "mid",
        companyId: attribution?.companyId,
        agentId: attribution?.agentId,
        issueId: attribution?.issueId,
        userId: attribution?.userId,
      })
    )
    .digest("hex");
}

function formatScopedMemories(
  memories: Parameters<typeof formatMemories>[0],
  bankId: string
): string {
  const text = formatMemories(memories);
  if (!text) return "";
  return `Backend bank scope: ${JSON.stringify(bankId)}. Shared/static bank configuration can share evidence across principals; metadata and tags are not authorization. Backend tenancy/access controls remain authoritative.\n${text}`;
}

function sourceTime(value: unknown): string {
  return formatTimestamp(
    value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : value
  );
}

interface RunStartedPayload {
  agentId: string;
  runId: string;
  issueId?: string | null;
}

interface RunFinishedPayload {
  agentId: string;
  runId: string;
}

interface CommentCreatedPayload {
  commentId?: string;
  bodySnippet?: string;
  agentId?: string | null;
  runId?: string | null;
}

async function getConfig(ctx: {
  config: { get(): Promise<Record<string, unknown>> };
}): Promise<PluginConfig> {
  return (await ctx.config.get()) as unknown as PluginConfig;
}

async function resolveApiKey(
  ctx: Pick<PluginContext, "secrets">,
  config: PluginConfig,
  companyId: string
): Promise<string | undefined> {
  if (!config.hindsightApiKeyRef) return undefined;
  // configPath identifies which binding to read when a plugin holds several
  // secrets; companyId scopes the lookup to the run's company.
  const resolved = await ctx.secrets.resolve(config.hindsightApiKeyRef, {
    companyId,
    configPath: "hindsightApiKeyRef",
  });
  return resolved ?? undefined;
}

function isAgentEnabled(config: PluginConfig, agentId: string | undefined | null): boolean {
  const allowlist = config.enabledAgentIds;
  if (!allowlist || allowlist.length === 0) return true;
  return !!agentId && allowlist.includes(agentId);
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Hindsight memory plugin starting");

    // ---------------------------------------------------------------------------
    // agent.run.started — recall memories using the issue's title + description
    //
    // Paperclip's lifecycle payload only includes runId/agentId/issueId/etc.,
    // so we fetch the issue via ctx.issues.get to obtain the title/description
    // we need for a meaningful recall query.
    // ---------------------------------------------------------------------------
    ctx.events.on("agent.run.started", async (event) => {
      const payload = event.payload as RunStartedPayload;
      const config = await getConfig(ctx);
      const { agentId, runId, issueId } = payload;
      const companyId = event.companyId;
      if (!isAgentEnabled(config, agentId)) return;
      if (!companyId) return;
      // Reused run IDs must not keep the prior issue/user or recalled evidence
      // when the new host association is absent, unreadable or has no user.
      await ctx.state.set(
        { scopeKind: "run", scopeId: runId, stateKey: "memory-attribution" },
        null
      );
      await ctx.state.set({ scopeKind: "run", scopeId: runId, stateKey: "user-id" }, null);
      await ctx.state.set(
        { scopeKind: "run", scopeId: runId, stateKey: "recalled-memories" },
        null
      );
      if (!issueId) return;

      let issue;
      try {
        issue = await ctx.issues.get(issueId, companyId);
      } catch (err) {
        ctx.logger.warn("Failed to fetch issue for recall", {
          runId,
          issueId,
          error: String(err),
        });
        return;
      }
      if (!issue) return;

      const query = [issue.title, issue.description].filter(Boolean).join("\n");

      // Extract userId from the specific issue being worked on (not an
      // arbitrary one from list). This is only used when bankGranularity
      // includes "user".
      const userId = config.bankGranularity?.includes("user")
        ? extractUserFromIssue(issue)
        : undefined;

      const attribution: RunAttribution = { companyId, agentId, issueId, userId };
      await ctx.state.set(
        { scopeKind: "run", scopeId: runId, stateKey: "memory-attribution" },
        attribution
      );
      // Keep the host-visible scalar current, including explicitly absent users.
      await ctx.state.set(
        { scopeKind: "run", scopeId: runId, stateKey: "user-id" },
        userId ?? null
      );
      if (!query.trim()) return;

      try {
        const apiKey = await resolveApiKey(ctx, config, companyId);
        const client = new HindsightClient(config.hindsightApiUrl, apiKey, config.requestTimeoutMs);
        const bankId = deriveBankId({ companyId, agentId, userId }, config);

        const response = await client.recall(bankId, query, config.recallBudget ?? "mid");

        const memories = formatScopedMemories(response.results, bankId);
        if (memories) {
          await ctx.state.set(
            { scopeKind: "run", scopeId: runId, stateKey: "recalled-memories" },
            memories
          );
          // Publish the query, scope and formatted result atomically: separate
          // cache keys could join a new principal to an old result after a race.
          await ctx.state.set(
            { scopeKind: "run", scopeId: runId, stateKey: "memory-attribution" },
            {
              ...attribution,
              recall: { query, scope: recallScope(config, bankId, attribution), memories },
            }
          );
          ctx.logger.info("Recalled memories for run", {
            runId,
            bankId,
            count: response.results.length,
          });
        }
      } catch (err) {
        // Non-fatal: agent runs without memory context.
        ctx.logger.warn("Failed to recall memories on run start", {
          runId,
          error: String(err),
        });
      }
    });

    // ---------------------------------------------------------------------------
    // issue.comment.created — retain the full comment body
    //
    // Paperclip's comment-created event payload only carries a 120-char snippet,
    // so we fetch the full comment via ctx.issues.listComments. Comments are the
    // primary durable record of agent + user output, so this captures both.
    // ---------------------------------------------------------------------------
    ctx.events.on("issue.comment.created", async (event) => {
      const config = await getConfig(ctx);
      if (config.autoRetain === false) return;

      const companyId = event.companyId;
      const issueId = event.entityId;
      const payload = (event.payload ?? {}) as CommentCreatedPayload;
      const commentId = payload.commentId;
      if (!issueId || !companyId || !commentId) return;

      let comment;
      try {
        const comments = await ctx.issues.listComments(issueId, companyId);
        comment = comments.find(
          (c) => c.id === commentId && c.companyId === companyId && c.issueId === issueId
        );
      } catch (err) {
        // A snippet is not a raw episode. Keep the failure visible rather than
        // misrepresenting truncated text as a fully captured source document.
        ctx.logger.warn("Failed to fetch full source comment", { commentId, error: String(err) });
        return;
      }
      if (!comment || typeof comment.body !== "string" || !comment.body.trim()) return;
      const body = comment.body;

      // Fetch-authenticated author identity wins over payload/body claims.
      // User/system authors remain distinct from the assignee whose bank stores
      // their evidence; that bank agent is not misrepresented as the speaker.
      let bankAgentId: string | null = comment.authorAgentId;
      let userId: string | undefined;
      let issueForAttribution;
      if (!bankAgentId || config.bankGranularity?.includes("user")) {
        try {
          issueForAttribution = await ctx.issues.get(issueId, companyId);
          if (!bankAgentId) {
            bankAgentId = issueForAttribution?.assigneeAgentId ?? null;
          }
          if (config.bankGranularity?.includes("user") && issueForAttribution) {
            userId = extractUserFromIssue(issueForAttribution);
          }
        } catch {
          /* ignore — userId stays undefined, bankAgentId fallback already handled */
        }
      }

      if (!bankAgentId) {
        ctx.logger.info("Skipping retain — no agent attribution available", {
          commentId,
          issueId,
        });
        return;
      }

      if (!isAgentEnabled(config, bankAgentId)) {
        ctx.logger.debug("Skipping retain — agent not in enabled list", {
          commentId,
          agentId: bankAgentId,
        });
        return;
      }

      try {
        const apiKey = await resolveApiKey(ctx, config, companyId);
        const client = new HindsightClient(config.hindsightApiUrl, apiKey, config.requestTimeoutMs);
        const bankId = deriveBankId({ companyId, agentId: bankAgentId, userId }, config);
        const createdAt = sourceTime(comment.createdAt);
        const updatedAt = sourceTime(comment.updatedAt);
        // Document replacement is native Hindsight behavior. Version the full
        // source identity + bytes + trusted source revision clock so an edit,
        // or a revert to earlier bytes (A→B→A), cannot overwrite a prior
        // episode; a redelivery with the same body and source clock (capture
        // time excluded) remains idempotent.
        const digest = createHash("sha256")
          .update(JSON.stringify([companyId, issueId, commentId, body, updatedAt]))
          .digest("hex");
        const runId = comment.createdByRunId ?? payload.runId ?? "unknown";
        await client.retain(
          bankId,
          body,
          `paperclip-comment-${digest}`,
          {
            agentId: bankAgentId,
            companyId,
            issueId,
            commentId,
            runId,
            "paperclip.provenance.source_type": "issue_comment",
            "paperclip.provenance.source_id": commentId,
            "paperclip.provenance.source_ref": `paperclip:comment:${encodeURIComponent(companyId)}:${encodeURIComponent(issueId)}:${encodeURIComponent(commentId)}:${digest}`,
            "paperclip.provenance.recorded_at": new Date().toISOString(),
            "paperclip.provenance.source_created_at": createdAt,
            "paperclip.provenance.source_updated_at": updatedAt,
            "paperclip.provenance.role": comment.authorType ?? "unknown",
            "paperclip.provenance.author_agent_id": comment.authorAgentId ?? "unknown",
            "paperclip.provenance.author_user_id": comment.authorUserId ?? "unknown",
          },
          updatedAt !== "unknown" ? updatedAt : createdAt !== "unknown" ? createdAt : "unset"
        );
        ctx.logger.info("Retained comment to memory", { commentId, bankId });
      } catch (err) {
        ctx.logger.warn("Failed to retain comment", {
          commentId,
          error: String(err),
        });
      }
    });

    // ---------------------------------------------------------------------------
    // agent.run.finished — no-op
    //
    // Paperclip's run-lifecycle payload only includes status/timing fields and
    // does not carry the agent's output. Retention now flows through the
    // issue.comment.created handler above. The subscription is kept so the
    // plugin remains visible in the event subscription list and so future
    // payload additions (e.g. an output reference) can be picked up here.
    // ---------------------------------------------------------------------------
    ctx.events.on("agent.run.finished", async (event) => {
      const payload = event.payload as RunFinishedPayload;
      const config = await getConfig(ctx);
      if (!isAgentEnabled(config, payload?.agentId)) return;
      ctx.logger.debug(
        "agent.run.finished received (no-op; retention handled by issue.comment.created)",
        { runId: payload?.runId }
      );
    });

    // ---------------------------------------------------------------------------
    // Tool: hindsight_recall
    // ---------------------------------------------------------------------------
    ctx.tools.register(
      "hindsight_recall",
      {
        displayName: "Recall from Memory",
        description: "Search Hindsight long-term memory for context relevant to a query.",
        parametersSchema: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string", description: "What to search for" },
          },
        },
      },
      async (params: unknown, runCtx: ToolRunContext) => {
        const { query } = params as { query: string };
        const config = await getConfig(ctx);

        const attribution = await readRunAttribution(ctx, runCtx);
        const userId = config.bankGranularity?.includes("user") ? attribution?.userId : undefined;

        const bankId = deriveBankId(
          { companyId: runCtx.companyId, agentId: runCtx.agentId, userId },
          config
        );

        // A matching query alone does not identify a memory store: bind the
        // cache to the trusted principal, task/user, bank and backend identity.
        const cached = attribution?.recall;
        if (
          cached &&
          cached.query.trim() === query.trim() &&
          cached.scope === recallScope(config, bankId, attribution)
        ) {
          return { content: cached.memories };
        }

        // Live recall fallback
        try {
          const apiKey = await resolveApiKey(ctx, config, runCtx.companyId);
          const client = new HindsightClient(
            config.hindsightApiUrl,
            apiKey,
            config.requestTimeoutMs
          );
          const response = await client.recall(bankId, query, config.recallBudget ?? "mid");
          const memories = formatScopedMemories(response.results, bankId);
          return { content: memories || "No relevant memories found." };
        } catch (err) {
          return { content: `Memory recall failed: ${String(err)}` };
        }
      }
    );

    // ---------------------------------------------------------------------------
    // Tool: hindsight_retain
    // ---------------------------------------------------------------------------
    ctx.tools.register(
      "hindsight_retain",
      {
        displayName: "Save to Memory",
        description:
          "Store important facts, decisions, or outcomes in Hindsight long-term memory for future runs.",
        parametersSchema: retainParametersSchema,
      },
      async (params: unknown, runCtx: ToolRunContext) => {
        const { content, observedAt, validUntil, supersedes } = (params ?? {}) as {
          content?: unknown;
          observedAt?: unknown;
          validUntil?: unknown;
          supersedes?: unknown;
        };
        if (typeof content !== "string" || !content.trim()) {
          return {
            content: "Failed to save memory: content must be a non-empty string.",
            error: "invalid-content",
          };
        }
        const observation = formatTimestamp(observedAt);
        const validity = formatTimestamp(validUntil);
        if (
          (observedAt !== undefined && observation === "unknown") ||
          (validUntil !== undefined && validity === "unknown")
        ) {
          return {
            content:
              "Failed to save memory: invalid observedAt or validUntil; use ISO 8601 with an explicit timezone.",
            error: "invalid-timestamp",
          };
        }
        if (
          supersedes !== undefined &&
          (typeof supersedes !== "string" || !supersedes.trim() || supersedes.length > 512)
        ) {
          return {
            content:
              "Failed to save memory: invalid supersedes reference (1-512 characters required).",
            error: "invalid-supersedes",
          };
        }
        const config = await getConfig(ctx);

        const attribution = await readRunAttribution(ctx, runCtx);
        const userId = config.bankGranularity?.includes("user") ? attribution?.userId : undefined;

        const bankId = deriveBankId(
          { companyId: runCtx.companyId, agentId: runCtx.agentId, userId },
          config
        );

        try {
          const apiKey = await resolveApiKey(ctx, config, runCtx.companyId);
          const client = new HindsightClient(
            config.hindsightApiUrl,
            apiKey,
            config.requestTimeoutMs
          );
          const sourceId = randomUUID();
          await client.retain(
            bankId,
            content,
            `paperclip-explicit-${sourceId}`,
            {
              agentId: runCtx.agentId,
              companyId: runCtx.companyId,
              runId: runCtx.runId,
              issueId: attribution?.issueId ?? "unknown",
              "paperclip.provenance.source_type": "explicit_retain",
              "paperclip.provenance.source_id": sourceId,
              "paperclip.provenance.source_ref": `paperclip:run:${encodeURIComponent(runCtx.companyId)}:${encodeURIComponent(runCtx.agentId)}:${encodeURIComponent(runCtx.runId)}:memory:${sourceId}`,
              "paperclip.provenance.recorded_at": new Date().toISOString(),
              "paperclip.provenance.role": "agent",
              ...(observedAt !== undefined
                ? { "paperclip.provenance.observed_at": observation }
                : {}),
              ...(validUntil !== undefined ? { "paperclip.provenance.valid_until": validity } : {}),
              ...(typeof supersedes === "string"
                ? { "paperclip.provenance.supersedes": supersedes }
                : {}),
            },
            observation === "unknown" ? "unset" : observation
          );
          // An accepted write can add newer validity/supersession evidence.
          // Never serve the earlier run-start result after this operation.
          try {
            const current = await readRunAttribution(ctx, runCtx);
            if (current) {
              await ctx.state.set(
                { scopeKind: "run", scopeId: runCtx.runId, stateKey: "memory-attribution" },
                { ...current, recall: undefined }
              );
              await ctx.state.set(
                { scopeKind: "run", scopeId: runCtx.runId, stateKey: "recalled-memories" },
                null
              );
            }
          } catch {
            // Retention was already accepted; a cache outage is not a failed
            // write, and must not cause the caller to resubmit raw history.
            ctx.logger.warn("Memory accepted but recall cache invalidation failed", {
              runId: runCtx.runId,
            });
            return {
              content:
                "Memory saved, but cached context invalidation failed. Use a different recall query for a fresh read.",
            };
          }
          return { content: "Memory saved." };
        } catch (err) {
          return { content: `Failed to save memory: ${String(err)}` };
        }
      }
    );

    ctx.logger.info("Hindsight memory plugin ready");
  },

  async onHealth() {
    return { status: "ok" };
  },

  async onValidateConfig(config) {
    const c = config as Partial<PluginConfig>;
    if (!c.hindsightApiUrl?.trim()) {
      return { ok: false, errors: ["hindsightApiUrl is required"] };
    }

    try {
      const client = new HindsightClient(c.hindsightApiUrl, undefined, c.requestTimeoutMs);
      const healthy = await client.health();
      if (!healthy) {
        return {
          ok: false,
          errors: [`Cannot reach Hindsight at ${c.hindsightApiUrl}`],
        };
      }
    } catch (err) {
      return { ok: false, errors: [`Connection failed: ${String(err)}`] };
    }

    return { ok: true };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
