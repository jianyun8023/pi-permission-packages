import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type AuditResolution,
  type AuditSource,
  PERMISSION_AUDIT_CHANNEL,
  PERMISSION_AUDIT_TYPE,
  type PermissionAuditEntry,
} from "#src/service/permission-audit";
import type {
  PermissionDecisionEvent,
  PermissionUiPromptEvent,
} from "#src/service/permission-events";
import { redactCommandSecrets } from "./command-redaction";
import type { SessionLogger } from "./session-logger";

type Context = {
  ctx: ExtensionContext;
  sessionId: string;
  generationId: string;
  anchorEntryId: string | null;
  toolCallId: string | null;
  parentToolCallId: string | null;
  toolName: string | null;
  cancelled: boolean;
};
type Pending = {
  context: Context;
  entry: PermissionAuditEntry;
  reason: string;
  missingReviewer: boolean;
};
function string(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
/** Bound named secret values even when quoted by a model. Free anonymous secrets cannot be identified reliably. */
export function auditText(value: unknown): string {
  if (typeof value !== "string") return "";
  return (
    redactCommandSecrets(value)
      .replace(
        /((?:authorization|api[_-]?key|password|passwd|secret|token|cookie)\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
        "$1[redacted]",
      )
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Audit text must strip terminal control characters.
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .slice(0, 800)
  );
}
function readAnchor(ctx: ExtensionContext): string | null {
  try {
    return ctx.sessionManager.getLeafId();
  } catch {
    return null;
  }
}
function sourceFor(resolution: AuditResolution): AuditSource {
  if (
    resolution.startsWith("policy_") ||
    resolution === "infrastructure_auto_allowed"
  )
    return "policy";
  if (resolution === "session_approved") return "session_grant";
  if (resolution.startsWith("authorizer_")) return "reviewer";
  if (resolution.startsWith("user_")) return "human";
  return "system";
}

/** One observer/writer per extension session. All methods are observational. */
export class SessionPermissionAudit {
  private readonly calls = new AsyncLocalStorage<Context>();
  private readonly pending = new Map<string, Pending>();
  private readonly finished = new Set<string>();
  private generationId = randomUUID();
  private ctx: ExtensionContext | undefined;
  private warned = false;
  constructor(
    private readonly pi: Pick<ExtensionAPI, "appendEntry" | "events">,
  ) {}

  activate(ctx: ExtensionContext): void {
    this.interrupt();
    this.generationId = randomUUID();
    this.ctx = ctx;
    this.warned = false;
    this.finished.clear();
  }

  async run<T>(
    ctx: ExtensionContext,
    event: unknown,
    action: () => Promise<T>,
    tool = true,
  ): Promise<T> {
    const input = record(event);
    const context: Context = {
      ctx,
      sessionId: ctx.sessionManager.getSessionId(),
      generationId: this.generationId,
      anchorEntryId: readAnchor(ctx),
      toolCallId: string(input.toolCallId),
      parentToolCallId: string(input.parentToolCallId),
      toolName: string(input.toolName),
      cancelled: false,
    };
    return this.calls.run(context, async () => {
      const result = await action();
      this.safely(() => {
        if (tool && context.generationId === this.generationId) {
          const denied =
            record(result).block === true ||
            context.cancelled ||
            ctx.signal?.aborted === true;
          const state = this.create(
            `tool:${context.toolCallId ?? randomUUID()}`,
            {},
            context,
          );
          state.entry.kind = "tool";
          state.entry.final = {
            result: denied ? "deny" : "allow",
            source: "composed",
            resolution:
              context.cancelled || ctx.signal?.aborted
                ? "cancelled"
                : denied
                  ? "tool_blocked"
                  : "tool_allowed",
            reasonSummary: auditText(record(result).reason),
          };
          this.write(state, "resolved");
        }
      });
      return result;
    });
  }

  decorate(logger: SessionLogger): SessionLogger {
    return {
      debug: (event, details) => logger.debug(event, details),
      warn: (message) => logger.warn(message),
      review: (event, details) => {
        logger.review(event, details);
        this.safely(() => this.log(event, details ?? {}));
      },
    };
  }

  private create(
    requestId: string,
    facts: Record<string, unknown>,
    context = this.calls.getStore() ?? this.fallback(facts),
  ): Pending {
    const requester = string(facts.requesterSessionId);
    return {
      context,
      reason: "",
      missingReviewer: false,
      entry: {
        schemaVersion: 1,
        eventId: randomUUID(),
        sessionId: requester ?? context.sessionId,
        adjudicatorSessionId: context.sessionId,
        generationId: context.generationId,
        anchorEntryId: context.anchorEntryId,
        toolCallId: string(facts.toolCallId) ?? context.toolCallId,
        parentToolCallId: context.parentToolCallId,
        requestId,
        sequence: 0,
        kind: "gate",
        phase: "started",
        occurredAt: new Date().toISOString(),
        request: {
          surface: auditText(
            facts.surface ?? facts.toolName ?? context.toolName ?? "unknown",
          ),
          toolName: string(facts.toolName) ?? context.toolName,
          targetSummary: auditText(
            facts.decidingPath ??
              facts.path ??
              facts.target ??
              facts.value ??
              facts.toolName ??
              context.toolName ??
              facts.surface ??
              "",
          ),
          matchedRule: facts.matchedPattern
            ? auditText(facts.matchedPattern)
            : null,
          policyOrigin: string(facts.origin),
        },
      },
    };
  }

  private fallback(facts: Record<string, unknown>): Context {
    if (!this.ctx) throw new Error("Audit session is not active");
    return {
      ctx: this.ctx,
      sessionId: this.ctx.sessionManager.getSessionId(),
      generationId: this.generationId,
      anchorEntryId: readAnchor(this.ctx),
      toolCallId: string(facts.toolCallId),
      parentToolCallId: null,
      toolName: string(facts.toolName),
      cancelled: false,
    };
  }

  private log(event: string, facts: Record<string, unknown>): void {
    const id = string(facts.requestId);
    if (!id || !this.ctx || this.finished.has(id)) return;
    const caller = this.calls.getStore();
    if (
      caller &&
      (caller.generationId !== this.generationId || caller.cancelled)
    )
      return;
    let state = this.pending.get(id);
    if (!state) {
      if (
        event !== "permission_request.waiting" &&
        event !== "pi_auto_review_decision" &&
        event !== "authorizer_chain_unregistered_link"
      )
        return;
      state = this.create(id, facts);
      this.pending.set(id, state);
    }
    if (event === "permission_request.waiting") {
      state.entry.request = this.create(id, facts, state.context).entry.request;
      this.write(state, "started");
    }
    if (
      event === "authorizer_chain_unregistered_link" &&
      facts.name === "pi-auto-review"
    )
      state.missingReviewer = true;
    if (event === "pi_auto_review_decision") {
      const outcome = facts.reviewerOutcome;
      if (outcome !== "allow" && outcome !== "deny" && outcome !== "defer")
        return;
      state.entry.review = {
        outcome,
        reasonCode:
          facts.unavailable === true
            ? Array.isArray(facts.retryErrors) &&
              facts.retryErrors.includes("timeout")
              ? "review_timeout"
              : "review_unavailable"
            : Number(facts.attempts) === 0 && outcome === "deny"
              ? "hard_deny"
              : "verdict",
        reasonSummary: auditText(facts.rationale),
        model: auditText(facts.reviewerModel ?? facts.model),
        durationMs:
          typeof facts.durationMs === "number"
            ? Math.max(0, facts.durationMs)
            : 0,
        attempts: typeof facts.attempts === "number" ? facts.attempts : 0,
      };
      this.write(state, "reviewed");
    }
    if (facts.denialReason || facts.error)
      state.reason = auditText(facts.denialReason ?? facts.error);
  }

  prompt(event: PermissionUiPromptEvent): void {
    this.safely(() => {
      const state = this.pending.get(event.requestId);
      if (state && !state.context.cancelled)
        this.write(state, "awaiting_human");
    });
  }

  decision(event: PermissionDecisionEvent): PermissionDecisionEvent {
    let output = event;
    this.safely(() => {
      if (this.finished.has(event.requestId)) return;
      const caller = this.calls.getStore();
      if (
        caller &&
        (caller.generationId !== this.generationId || caller.cancelled)
      )
        return;
      const state =
        this.pending.get(event.requestId) ??
        this.create(
          event.requestId,
          event as unknown as Record<string, unknown>,
        );
      this.pending.delete(event.requestId);
      this.finished.add(event.requestId);
      const cancelled =
        state.context.cancelled || state.context.ctx.signal?.aborted;
      const resolution = cancelled
        ? "cancelled"
        : state.missingReviewer
          ? "reviewer_not_registered"
          : event.resolution;
      state.entry.request.surface = auditText(event.surface);
      state.entry.request.matchedRule = event.matchedPattern
        ? auditText(event.matchedPattern)
        : null;
      state.entry.request.policyOrigin = event.origin;
      state.entry.final = {
        result: cancelled ? "deny" : event.result,
        source: sourceFor(resolution),
        resolution,
        reasonSummary: state.reason,
      };
      this.write(state, "resolved");
      output = {
        ...event,
        sessionId: state.entry.sessionId,
        adjudicatorSessionId: state.entry.adjudicatorSessionId,
        toolCallId: state.entry.toolCallId,
        parentToolCallId: state.entry.parentToolCallId,
        generationId: state.entry.generationId,
      };
    });
    return output;
  }

  interrupt(): void {
    for (const state of this.pending.values()) {
      state.context.cancelled = true;
      this.finished.add(state.entry.requestId);
      state.entry.final = {
        result: "deny",
        source: "system",
        resolution: "cancelled",
        reasonSummary: "",
      };
      this.write(state, "resolved");
    }
    this.pending.clear();
  }

  private write(state: Pending, phase: PermissionAuditEntry["phase"]): void {
    this.safely(() => {
      const entry = {
        ...state.entry,
        request: { ...state.entry.request },
        phase,
        sequence: ++state.entry.sequence,
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
      };
      const hasConversation = state.context.ctx.sessionManager
        .getEntries()
        .some(
          (item) =>
            item.type === "message" &&
            (item.message.role === "user" || item.message.role === "assistant"),
        );
      let storage: "saved" | "memory" | "error" =
        hasConversation && state.context.ctx.sessionManager.getSessionFile()
          ? "saved"
          : "memory";
      try {
        this.pi.appendEntry(PERMISSION_AUDIT_TYPE, entry);
      } catch {
        storage = "error";
      }
      this.pi.events.emit(PERMISSION_AUDIT_CHANNEL, { entry, storage });
      if (storage === "error" && !this.warned) {
        this.warned = true;
        this.ctx?.ui.notify(
          "Permission audit could not be saved; authorization rules are still active.",
          "warning",
        );
      }
    });
  }
  private safely(action: () => void): void {
    try {
      action();
    } catch {
      /* Observation must not change authorization. */
    }
  }
}
