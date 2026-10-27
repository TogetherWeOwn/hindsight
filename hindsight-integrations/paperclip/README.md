# @vectorize-io/hindsight-paperclip

Persistent long-term memory for Paperclip agents via [Hindsight](https://github.com/vectorize-io/hindsight).

Install once. Every agent in your Paperclip instance gets memory that persists across runs, companies, and restarts.

## What It Does

- **Before each run** — fetches the run's issue and recalls relevant memories on its title + description, caches them for the agent
- **After each comment** — retains the full comment body to Hindsight (durable record of both user and agent output)
- **Agent tools** — `hindsight_recall` and `hindsight_retain` tools for agents to query and store memory mid-run

## Installation

```bash
pnpm paperclipai plugin install @vectorize-io/hindsight-paperclip
```

Then configure in **Settings → Plugins → Hindsight Memory**.

## Prerequisites

Requires Paperclip **2026.720.0 or newer**. Upgrading from an older plugin version? Open the plugin settings and pick the API key secret again: older versions saved the secret's name, and Paperclip now accepts only a reference chosen with the secret picker.

> ✨ **Recommended:** [Hindsight Cloud](https://ui.hindsight.vectorize.io) — sign up free, get an API key, and skip the self-hosting setup entirely.

**Self-hosting alternative** — run Hindsight locally:

```bash
pip install hindsight-all
export HINDSIGHT_API_LLM_API_KEY=your-openai-key
hindsight-api
```

## Configuration

| Field                | Default                              | Description                                                                                                                                                            |
| -------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hindsightApiUrl`    | `https://api.hindsight.vectorize.io` | Hindsight server URL (Cloud default; use `http://localhost:8888` for self-hosted)                                                                                      |
| `hindsightApiKeyRef` | —                                    | Paperclip secret holding your Hindsight Cloud API key, chosen with the secret picker. Leave empty for self-hosted                                                      |
| `dynamicBankId`      | `true`                               | When `true`, bank ID is derived from `bankGranularity`. Set `false` and provide `bankId` to share one static memory bank across agents                                 |
| `bankId`             | —                                    | Static bank ID used when `dynamicBankId` is `false`. All agents sharing this value read/write the same memory bank                                                     |
| `bankGranularity`    | `["company", "agent"]`               | Memory isolation when `dynamicBankId` is `true`: per company+agent, per company, or per agent. Add `"user"` for per-user memory isolation (useful for GDPR compliance) |
| `recallBudget`       | `mid`                                | `low` = fastest, `mid` = balanced, `high` = most thorough                                                                                                              |
| `requestTimeoutMs`   | `15000`                              | Timeout for each request to Hindsight. Raise it for self-hosted instances where recall on long issue descriptions is slower                                            |
| `autoRetain`         | `true`                               | Automatically retain run output after every run                                                                                                                        |
| `enabledAgentIds`    | —                                    | Restrict recall/retain to these agent IDs only. Leave empty to enable for all agents (default)                                                                         |

## Bank ID Format

```
paperclip::{companyId}::{agentId}                  ← default (company + agent granularity)
paperclip::{companyId}                             ← company granularity (shared across agents)
paperclip::{agentId}                               ← agent granularity (agent memory across companies)
paperclip::{companyId}::{agentId}::user::{userId}  ← user granularity (per-user isolation, GDPR-friendly)
{bankId}                                           ← static shared bank (dynamicBankId = false)
```

## Agent Tools

Agents can call these tools directly during a run:

**`hindsight_recall(query)`** — search memory for relevant context. Called automatically at run start; agents can also call it mid-run for targeted queries. The run-start result is reused only when the agent asks the same query; any other query triggers a live recall.

**`hindsight_retain(content, observedAt?, validUntil?, supersedes?)`** — submit the full original fact or decision for asynchronous retention, without waiting for run end. Optional `observedAt` supplies a known observation time; `validUntil` and `supersedes` attach unverified claims to a new, independent source document. Both times require valid ISO 8601 instants with explicit timezones. Invalid supplied annotations fail before submission instead of silently substituting now; omitting them keeps legacy content-only calls valid. `supersedes` is a reference (1–512 characters), never an instruction to delete or replace the previous document.

## Memory provenance, time and scope

Recall preserves legacy text-only evidence and adds a JSON-encoded trust envelope for each result:

- Native memory/document identities, event interval (`occurred_start` / `occurred_end`) and mention time (`mentioned_at`). Missing, malformed or timezone-ambiguous values are explicitly `unknown`; mention time is not capture time.
- Source reference, capture time and company/agent/task/run/source-speaker attribution from `paperclip.provenance.*` and the existing identity metadata. Speaker role means `agent`, `user` or `system`, not an organizational job role or a permission.
- `validity_status` and `supersession_status` stay `unknown`: Hindsight's native recall contract does not establish either. A writer's `valid_until` or `supersedes` annotation is displayed as an **unverified claim**, never proof of current authority.

Text and attribution are JSON-quoted to keep multiline content from forging another envelope line. This is structural encoding, **not** prompt-injection enforcement: recalled content and source metadata remain untrusted historical evidence, not instructions, approvals or authorization.

Automatic retention fetches the complete comment and its author/timestamps from the company-scoped host API. A payload snippet cannot replace the full source. If that read fails, the plugin logs the failure instead of storing a snippet as a complete episode. The plugin does not add a retry scheduler; full capture still depends on a successful host read/event delivery.

Comment document IDs hash company, task, comment identity, the **full raw body** and the host's comment `updatedAt` (the source revision clock; capture time is excluded). Redelivering the same version reuses its ID; editing the source, or reverting it to earlier text with a newer `updatedAt`, creates a new document without deleting or overwriting the old version. Distinct comments with identical text remain distinct. Explicit retains get unique source/document IDs even for identical content captured in the same millisecond. Existing documents are not migrated, deleted or rewritten.

Both writers keep the original body unchanged and attach string-valued metadata under `paperclip.provenance.*`: `source_type`, `source_id`, `source_ref`, `recorded_at`, `role`; automatic comments additionally include `source_created_at`, `source_updated_at` and speaker identities. Source references are stable `paperclip:comment:` / `paperclip:run:` URIs identifying the company-scoped source, not public web URLs. Capture time is distinct from source time. When observation time is unavailable, the native retain `timestamp` is `"unset"`, not an omitted value that the backend would interpret as now.

Bank selection is unchanged. Recall does **not** add task/role tag filters: useful cross-task evidence remains visible. Shared/static or cross-company banks share according to their configured backend access; attribution metadata and tags are **not an authorization boundary**. Use backend tenancy/access controls and the appropriate bank granularity for isolation. The run cache binds the formatted evidence to trusted company/agent/task/user context, selected bank, backend URL, secret-reference identity and recall budget. A scope change requires a fresh read; failure never returns old scoped evidence or echoes raw backend error bodies. No resolved credential is cached.

## How It Works

```
agent.run.started
  └─ fetch issue via ctx.issues.get
       └─ recall(issueTitle + description) → cached in plugin state for the run

agent running…
  ├─ hindsight_recall(query) → cached context if query matches run start, otherwise live recall
  └─ hindsight_retain(content) → stores immediately

issue.comment.created
  └─ retain(full comment body via ctx.issues.listComments)
       └─ bank attribution: agent comment author when present; otherwise issue assignee

agent.run.finished
  └─ no-op (subscription kept for future use when payload carries output)
```

The bundled plugin manifest declares the `issues.read` and `issue.comments.read` capabilities needed by the new SDK calls, so Paperclip may prompt for these on first install or upgrade.

Memory is keyed to `companyId` + `agentId`, never to the Paperclip session or run ID — so it survives across any number of runs.

## Development

```bash
npm install
npm run build
npm test
```

Local install into a running Paperclip instance:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/absolute/path/to/hindsight-integrations/paperclip","isLocalPath":true}'
```
