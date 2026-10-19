/** Pure, versioned display contract. These records never confer authority. */
export const PERMISSION_AUDIT_TYPE = "permission-audit/v1";
export const PERMISSION_AUDIT_CHANNEL = "permissions:audit";
export type AuditPhase = "started" | "reviewed" | "awaiting_human" | "resolved";
export type AuditSource =
  | "policy"
  | "session_grant"
  | "reviewer"
  | "human"
  | "system"
  | "composed";
export type AuditResolution =
  | "policy_allow"
  | "policy_deny"
  | "session_approved"
  | "infrastructure_auto_allowed"
  | "user_approved"
  | "user_approved_for_session"
  | "user_denied"
  | "auto_approved"
  | "confirmation_unavailable"
  | "prompt_unanswered"
  | "authorizer_allowed"
  | "authorizer_denied"
  | "gate_error"
  | "cancelled"
  | "reviewer_not_registered"
  | "tool_allowed"
  | "tool_blocked";
export type ReviewReasonCode =
  | "verdict"
  | "review_timeout"
  | "review_unavailable"
  | "hard_deny";
export interface PermissionAuditEntry {
  schemaVersion: 1;
  eventId: string;
  sessionId: string;
  adjudicatorSessionId: string;
  generationId: string;
  anchorEntryId: string | null;
  toolCallId: string | null;
  parentToolCallId: string | null;
  requestId: string;
  sequence: number;
  kind: "gate" | "tool";
  phase: AuditPhase;
  occurredAt: string;
  request: {
    surface: string;
    toolName: string | null;
    targetSummary: string;
    matchedRule: string | null;
    policyOrigin: string | null;
  };
  review?: {
    outcome: "allow" | "deny" | "defer";
    reasonCode: ReviewReasonCode;
    reasonSummary: string;
    model: string;
    durationMs: number;
    attempts: number;
  };
  final?: {
    result: "allow" | "deny";
    source: AuditSource;
    resolution: AuditResolution;
    reasonSummary: string;
  };
}
export interface PermissionAuditUpdate {
  entry: PermissionAuditEntry;
  storage: "saved" | "memory" | "error";
}

const phases = new Set(["started", "reviewed", "awaiting_human", "resolved"]);
const resolutions = new Set([
  "policy_allow",
  "policy_deny",
  "session_approved",
  "infrastructure_auto_allowed",
  "user_approved",
  "user_approved_for_session",
  "user_denied",
  "auto_approved",
  "confirmation_unavailable",
  "prompt_unanswered",
  "authorizer_allowed",
  "authorizer_denied",
  "gate_error",
  "cancelled",
  "reviewer_not_registered",
  "tool_allowed",
  "tool_blocked",
]);
const sources = new Set([
  "policy",
  "session_grant",
  "reviewer",
  "human",
  "system",
  "composed",
]);
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, max = 1024): value is string {
  return typeof value === "string" && value.length <= max;
}
function optionalText(value: unknown): boolean {
  return value === null || text(value);
}
/** Reject unknown/malformed data at each display boundary, including loaded files. */
export function isPermissionAuditEntry(
  value: unknown,
): value is PermissionAuditEntry {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    !["gate", "tool"].includes(String(value.kind)) ||
    !phases.has(String(value.phase))
  )
    return false;
  for (const key of [
    "eventId",
    "sessionId",
    "adjudicatorSessionId",
    "generationId",
    "requestId",
    "occurredAt",
  ])
    if (!text(value[key]) || !value[key]) return false;
  for (const key of ["anchorEntryId", "toolCallId", "parentToolCallId"])
    if (!optionalText(value[key])) return false;
  if (
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 1 ||
    !Number.isFinite(Date.parse(String(value.occurredAt)))
  )
    return false;
  const request = value.request;
  if (
    !object(request) ||
    !text(request.surface) ||
    !text(request.targetSummary) ||
    !optionalText(request.toolName) ||
    !optionalText(request.matchedRule) ||
    !optionalText(request.policyOrigin)
  )
    return false;
  const review = value.review;
  if (
    review !== undefined &&
    (!object(review) ||
      !["allow", "deny", "defer"].includes(String(review.outcome)) ||
      ![
        "verdict",
        "review_timeout",
        "review_unavailable",
        "hard_deny",
      ].includes(String(review.reasonCode)) ||
      !text(review.reasonSummary) ||
      !text(review.model) ||
      !Number.isFinite(review.durationMs) ||
      Number(review.durationMs) < 0 ||
      !Number.isSafeInteger(review.attempts) ||
      Number(review.attempts) < 0)
  )
    return false;
  const final = value.final;
  if (
    final !== undefined &&
    (!object(final) ||
      !["allow", "deny"].includes(String(final.result)) ||
      !sources.has(String(final.source)) ||
      !resolutions.has(String(final.resolution)) ||
      !text(final.reasonSummary))
  )
    return false;
  return (value.phase === "resolved") === (final !== undefined);
}

/** Copy known fields only. Unknown custom-entry keys never reach the browser. */
export function projectPermissionAuditEntry(
  value: unknown,
): PermissionAuditEntry | null {
  if (!isPermissionAuditEntry(value)) return null;
  const {
    schemaVersion,
    eventId,
    sessionId,
    adjudicatorSessionId,
    generationId,
    anchorEntryId,
    toolCallId,
    parentToolCallId,
    requestId,
    sequence,
    kind,
    phase,
    occurredAt,
    request,
    review,
    final,
  } = value;
  return {
    schemaVersion,
    eventId,
    sessionId,
    adjudicatorSessionId,
    generationId,
    anchorEntryId,
    toolCallId,
    parentToolCallId,
    requestId,
    sequence,
    kind,
    phase,
    occurredAt,
    request: {
      surface: request.surface,
      toolName: request.toolName,
      targetSummary: request.targetSummary,
      matchedRule: request.matchedRule,
      policyOrigin: request.policyOrigin,
    },
    ...(review
      ? {
          review: {
            outcome: review.outcome,
            reasonCode: review.reasonCode,
            reasonSummary: review.reasonSummary,
            model: review.model,
            durationMs: review.durationMs,
            attempts: review.attempts,
          },
        }
      : {}),
    ...(final
      ? {
          final: {
            result: final.result,
            source: final.source,
            resolution: final.resolution,
            reasonSummary: final.reasonSummary,
          },
        }
      : {}),
  };
}
