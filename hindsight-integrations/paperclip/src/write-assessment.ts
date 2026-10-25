/**
 * Report-only deterministic write assessment for Hindsight retention.
 *
 * `assessWrite` runs synchronously before each `client.retain` call (automatic
 * comment capture and the explicit retain tool) and produces advisory signals:
 * stable policy version, content digest, reason codes, and the trusted scoped
 * source identity. The caller attaches the result as additive namespaced
 * metadata and emits metric counters. Nothing here drops, delays, or alters a
 * write — enforcement is a separate, explicitly approved slice.
 *
 * The pattern lists are tripwires for the obvious cases (prompt injection,
 * forged approvals, cross-tenant identity claims), not a complete poisoning
 * detector. They are deliberately tight: agents routinely discuss their own
 * system prompts and log their own IDs in Paperclip comments, so those stay
 * silent to keep the signal usable. Revisit the lists with live
 * false-positive data, not by guessing.
 *
 * Quoted matches (email-style `>` quotes, fenced code blocks, same-line
 * double-quote containment) downgrade `advisory` but keep the underlying
 * signal codes: quoting says "this looked like an example", which is triage
 * context for a future enforcement slice, never proof of innocence.
 */

import { createHash } from "node:crypto";

/** Bumped whenever the pattern set or code semantics change. */
export const WRITE_ASSESSMENT_POLICY_VERSION = "paperclip-write-assessment/v1";

/**
 * Pattern scanning runs on at most this many head characters; the digest
 * always covers the full content.
 */
export const WRITE_ASSESSMENT_MAX_SCAN_CHARS = 32_768;

/** Recently-seen event identities kept per company for replay detection. */
export const WRITE_ASSESSMENT_DEDUP_WINDOW = 500;

const METADATA_PREFIX = "hindsight.write_assessment.";

export type WriteAssessmentPath = "auto-comment" | "explicit-tool";

export type WriteAssessmentReasonCode =
  | "benign"
  | "instruction_claim"
  | "authority_claim"
  | "identity_spoof_signal"
  | "cross_tenant_identity_mismatch"
  | "quoted_attack_text"
  | "malformed_content"
  | "malformed_metadata"
  | "oversize_input"
  | "unicode_ambiguity"
  | "duplicate_event"
  | "dedup_unavailable"
  | "assessment_error";

export interface WriteAssessmentInput {
  /** Which retain path is being assessed (caller-controlled). */
  path: WriteAssessmentPath;
  /** The exact content about to be retained (hostile: validated, never trusted). */
  content: unknown;
  /** Trusted runtime identity the bank was derived from (hostile-shaped: validated). */
  trustedSource: unknown;
  /** Stable event identity for replay detection, or null when the path has none. */
  replayIdentity: string | null;
  /** Recently-seen identities from plugin state (hostile-shaped: validated). */
  seenIdentities: unknown;
}

export interface WriteAssessment {
  policyVersion: string;
  path: WriteAssessmentPath;
  /** sha256 hex of the full retained content (empty-content hash when not a string). */
  digestSha256: string;
  /** Sorted, deduped; `["benign"]` only when no other code applies. */
  reasonCodes: WriteAssessmentReasonCode[];
  /** True when an unquoted content signal matched. Errors and replay use codes, not this flag. */
  advisory: boolean;
  /** True when content exceeded the scan bound (patterns ran on the head slice). */
  truncated: boolean;
  /** Trusted `company:{c}:agent:{a}[:run:{r}][:issue:{i}][:comment:{c}]`, or `"unknown"`. */
  sourceScope: string;
}

interface TextSpan {
  start: number;
  end: number;
}

interface TrustedSource {
  companyId: string;
  agentId: string;
  runId?: string;
  issueId?: string;
  commentId?: string;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const EMPTY_CONTENT_SHA256 = sha256Hex("");

// ---------------------------------------------------------------------------
// Signal patterns (all global for matchAll; case-insensitive prose matching)
// ---------------------------------------------------------------------------

const INSTRUCTION_PATTERNS: RegExp[] = [
  /\bignore\s+(all\s+)?(previous|prior|above)\s+instructions?\b/gi,
  /\bdisregard\s+(all\s+)?(previous|prior|above|your)\s+(instructions?|rules?|guidance)\b/gi,
  /\byou\s+are\s+now\b/gi,
  /\byour\s+new\s+instructions?\b/gi,
  // "Do not retain this" is an instruction aimed at the memory system itself.
  /\bdo\s+not\s+(retain|remember|store|log)\s+(this|that|it|the\s+above|the\s+conversation|this\s+conversation)\b/gi,
];

const AUTHORITY_PATTERNS: RegExp[] = [
  /\bapprov(?:ed|al)\s+by\b/gi,
  /\bauthori[sz]ed\s+by\b/gi,
  /\bowner\s+approv(?:ed|al)\b/gi,
  /\badmin\s+override\b/gi,
  /\bacting\s+as\s+(the\s+)?(owner|admin|administrator)\b/gi,
];

const IDENTITY_PROSE_PATTERNS: RegExp[] = [
  /\bi\s+am\s+the\s+(owner|admin|administrator|ceo)\b/gi,
  /\bthis\s+is\s+the\s+(owner|admin|administrator|ceo)\b/gi,
];

/** Scoped-ID claims (`agentId: x`, `company_id = "y"`); compared against trusted context. */
const AGENT_ID_CLAIM = /\bagent[_-]?id\s*[:=]\s*["']?([\w-]+)["']?/gi;
const COMPANY_ID_CLAIM = /\bcompany[_-]?id\s*[:=]\s*["']?([\w-]+)["']?/gi;

// Bidirectional controls, NULL, and other default-ignorable code points that
// change rendering or break UTF-8 sinks. Written as a code-point predicate
// (not a regex class) so every range stays visible ASCII in review.
// Zero-width joiners/spaces are deliberately excluded: they are legitimate
// typography (emoji, Indic scripts) and flagging them would drown the signal.
function isAmbiguousCodePoint(code: number): boolean {
  return (
    code === 0x00 || // NULL: breaks C-adjacent sinks and truncates naive readers
    (code >= 0x202a && code <= 0x202e) || // bidi embeddings/overrides/isolates
    (code >= 0x2066 && code <= 0x2069) || // bidi isolates
    code === 0x200e || // LEFT-TO-RIGHT MARK
    code === 0x200f || // RIGHT-TO-LEFT MARK
    code === 0xfeff || // ZERO WIDTH NO-BREAK SPACE
    (code >= 0xfff9 && code <= 0xfffb) // interlinear annotation anchors
  );
}

/** Collect one span per ambiguous code point in `text`. */
function collectAmbiguousSpans(text: string, spans: TextSpan[]): boolean {
  let found = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Skip low surrogates; lone surrogates are a backend-robustness question,
    // not a content signal, so they stay out of this slice.
    if (code >= 0xd800 && code <= 0xdbff) continue;
    if (isAmbiguousCodePoint(code)) {
      spans.push({ start: i, end: i + 1 });
      found = true;
    }
  }
  return found;
}

function collectSpans(text: string, pattern: RegExp, spans: TextSpan[]): boolean {
  let found = false;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    spans.push({ start, end: start + match[0].length });
    found = true;
  }
  return found;
}

/**
 * Fenced code spans in `text`; an unclosed fence quotes to end of input.
 * A closer must run at least as long as its opener, so a ```` fence
 * containing a ``` line still quotes the whole block.
 */
function fencedSpans(text: string): TextSpan[] {
  const spans: TextSpan[] = [];
  let openingLength = 0;
  let spanStart = 0;
  for (const match of text.matchAll(/`{3,}/g)) {
    const pos = match.index ?? 0;
    if (openingLength === 0) {
      openingLength = match[0].length;
      spanStart = pos + match[0].length;
    } else if (match[0].length >= openingLength) {
      spans.push({ start: spanStart, end: pos });
      openingLength = 0;
    }
    // A shorter run inside a fence is content, not a closer.
  }
  if (openingLength > 0) spans.push({ start: spanStart, end: text.length });
  return spans;
}

function isQuotedSpan(text: string, span: TextSpan, fences: TextSpan[]): boolean {
  // Inside a fenced code block (a sample, not an instruction).
  if (fences.some((f) => span.start >= f.start && span.start < f.end)) return true;

  const lineStart = text.lastIndexOf("\n", span.start - 1) + 1;
  const lineEnd = text.indexOf("\n", span.end);
  const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);

  // Email/chat-style quotation.
  if (line.trimStart().startsWith(">")) return true;

  // Inline quotation: a double quote on the same line both before and after.
  const before = line.slice(0, span.start - lineStart);
  const after = line.slice(span.end - lineStart);
  return before.includes('"') && after.includes('"');
}

function readTrustedSource(value: unknown): TrustedSource | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const companyId = record["companyId"];
  const agentId = record["agentId"];
  if (typeof companyId !== "string" || !companyId || typeof agentId !== "string" || !agentId) {
    return null;
  }
  const trusted: TrustedSource = { companyId, agentId };
  for (const key of ["runId", "issueId", "commentId"] as const) {
    const qualifier = record[key];
    if (typeof qualifier === "string" && qualifier) trusted[key] = qualifier;
  }
  return trusted;
}

function formatScope(trusted: TrustedSource): string {
  let scope = `company:${trusted.companyId}:agent:${trusted.agentId}`;
  if (trusted.runId) scope += `:run:${trusted.runId}`;
  if (trusted.issueId) scope += `:issue:${trusted.issueId}`;
  if (trusted.commentId) scope += `:comment:${trusted.commentId}`;
  return scope;
}

function assessInner(input: WriteAssessmentInput): WriteAssessment {
  const codes = new Set<WriteAssessmentReasonCode>();

  // Content: only strings are scannable; anything else is recorded, not executed.
  const text = typeof input.content === "string" ? input.content : "";
  if (typeof input.content !== "string") codes.add("malformed_content");
  const truncated = text.length > WRITE_ASSESSMENT_MAX_SCAN_CHARS;
  if (truncated) codes.add("oversize_input");
  const scanned = truncated ? text.slice(0, WRITE_ASSESSMENT_MAX_SCAN_CHARS) : text;
  const digestSha256 =
    typeof input.content === "string" ? sha256Hex(input.content) : EMPTY_CONTENT_SHA256;

  // Trusted identity: caller text must never override this.
  const trusted = readTrustedSource(input.trustedSource);
  if (!trusted) codes.add("malformed_metadata");
  const sourceScope = trusted ? formatScope(trusted) : "unknown";

  // Content signals, tracked as spans so quoting can be evaluated uniformly.
  const spans: TextSpan[] = [];
  for (const pattern of INSTRUCTION_PATTERNS) {
    if (collectSpans(scanned, pattern, spans)) codes.add("instruction_claim");
  }
  for (const pattern of AUTHORITY_PATTERNS) {
    if (collectSpans(scanned, pattern, spans)) codes.add("authority_claim");
  }
  for (const pattern of IDENTITY_PROSE_PATTERNS) {
    if (collectSpans(scanned, pattern, spans)) codes.add("identity_spoof_signal");
  }
  if (collectAmbiguousSpans(scanned, spans)) codes.add("unicode_ambiguity");

  // Scoped-ID claims: consistent with trusted context is silent; anything else is a signal.
  const agentClaims = [...scanned.matchAll(AGENT_ID_CLAIM)];
  const companyClaims = [...scanned.matchAll(COMPANY_ID_CLAIM)];
  if (!trusted) {
    if (agentClaims.length > 0 || companyClaims.length > 0) {
      codes.add("identity_spoof_signal");
    }
  } else {
    for (const match of [...agentClaims, ...companyClaims]) {
      const claimed = match[1] ?? "";
      const isAgentClaim = match[0].toLowerCase().startsWith("agent");
      const expected = isAgentClaim ? trusted.agentId : trusted.companyId;
      if (claimed !== expected) {
        const start = match.index ?? 0;
        spans.push({ start, end: start + match[0].length });
        codes.add("cross_tenant_identity_mismatch");
      }
    }
  }

  if (spans.length > 0) {
    const fences = fencedSpans(scanned);
    if (spans.every((span) => isQuotedSpan(scanned, span, fences))) {
      codes.add("quoted_attack_text");
    }
  }
  const advisory = spans.length > 0 && !codes.has("quoted_attack_text");

  // Replay: only paths with a stable event identity participate (the explicit
  // tool has none — same text twice is a legitimate re-save, not a redelivery).
  // A null/non-array window means unreadable; the caller maps a first-write
  // (no window stored yet) to [] before calling, so null is always an outage.
  if (input.replayIdentity !== null) {
    if (!Array.isArray(input.seenIdentities)) {
      codes.add("dedup_unavailable");
    } else if ((input.seenIdentities as unknown[]).includes(input.replayIdentity)) {
      codes.add("duplicate_event");
    }
  }

  if (codes.size === 0) codes.add("benign");
  return {
    policyVersion: WRITE_ASSESSMENT_POLICY_VERSION,
    path: input.path,
    digestSha256,
    reasonCodes: [...codes].sort(),
    advisory,
    truncated,
    sourceScope,
  };
}

/**
 * Assess a pending retain write. Total over hostile field values: garbage in
 * produces `malformed_*` / `assessment_error` codes, never a throw — the gate
 * must not become a new way to break retention.
 */
export function assessWrite(input: WriteAssessmentInput): WriteAssessment {
  try {
    return assessInner(input);
  } catch {
    let path: WriteAssessmentPath = "explicit-tool";
    try {
      if (input.path === "auto-comment") path = "auto-comment";
    } catch {
      /* fall through with the default; assessment_error marks the record untrusted */
    }
    return {
      policyVersion: WRITE_ASSESSMENT_POLICY_VERSION,
      path,
      digestSha256: EMPTY_CONTENT_SHA256,
      reasonCodes: ["assessment_error"],
      advisory: false,
      truncated: false,
      sourceScope: "unknown",
    };
  }
}

/**
 * Additive namespaced metadata for the retain item. String-only values (the
 * native `dict[str, str]` contract); the prefix cannot collide with existing
 * attribution keys or the provenance slice's planned fields.
 */
export function toAssessmentMetadata(assessment: WriteAssessment): Record<string, string> {
  return {
    [`${METADATA_PREFIX}policy_version`]: assessment.policyVersion,
    [`${METADATA_PREFIX}digest_sha256`]: assessment.digestSha256,
    [`${METADATA_PREFIX}reason_codes`]: assessment.reasonCodes.join(","),
    [`${METADATA_PREFIX}advisory`]: assessment.advisory ? "true" : "false",
    [`${METADATA_PREFIX}path`]: assessment.path,
    [`${METADATA_PREFIX}source_scope`]: assessment.sourceScope,
    [`${METADATA_PREFIX}truncated`]: assessment.truncated ? "true" : "false",
  };
}

/** Append `identity` to the bounded replay window, coercing corrupt stored values. */
export function updateSeenWindow(seen: unknown, identity: string): string[] {
  const window = Array.isArray(seen)
    ? seen.filter((entry): entry is string => typeof entry === "string")
    : [];
  return [...window.filter((entry) => entry !== identity), identity].slice(
    -WRITE_ASSESSMENT_DEDUP_WINDOW
  );
}
