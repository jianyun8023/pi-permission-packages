import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { auditText, SessionPermissionAudit } from "#src/logging/session-audit";
import {
  isPermissionAuditEntry,
  type PermissionAuditEntry,
  type PermissionAuditUpdate,
} from "#src/service/permission-audit";
import type { PermissionDecisionEvent } from "#src/service/permission-events";

function fixture(sessionId = "s1", failWrite = false) {
  const saved: PermissionAuditEntry[] = [],
    updates: PermissionAuditUpdate[] = [],
    notices: string[] = [];
  const controller = new AbortController();
  const ctx = {
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => "branch-a",
      getSessionFile: () => "/tmp/session.jsonl",
      getEntries: () => [{ type: "message", message: { role: "user" } }],
    },
    signal: controller.signal,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionContext;
  const audit = new SessionPermissionAudit({
    appendEntry: (_type, entry) => {
      if (failWrite) throw Error("disk full");
      saved.push(entry as PermissionAuditEntry);
    },
    events: {
      emit: (_channel, event) => updates.push(event as PermissionAuditUpdate),
      on: () => () => {},
    },
  });
  audit.activate(ctx);
  const logger = audit.decorate({
    review: () => {},
    debug: () => {},
    warn: () => {},
  });
  return { audit, ctx, saved, updates, notices, logger, controller };
}
function decision(
  requestId: string,
  result: "allow" | "deny" = "allow",
): PermissionDecisionEvent {
  return {
    requestId,
    surface: "read",
    value: "file",
    result,
    resolution: result === "allow" ? "authorizer_allowed" : "policy_deny",
    origin: "global",
    agentName: null,
    matchedPattern: "*",
  };
}
describe("session audit contract", () => {
  it("separates parallel tool calls and records tool outcome after all gates", async () => {
    const f = fixture();
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = f.audit.run(
      f.ctx,
      { toolCallId: "a", toolName: "write", parentToolCallId: "code" },
      async () => {
        f.logger.review("permission_request.waiting", {
          requestId: "a1",
          surface: "path_write",
        });
        await paused;
        f.audit.decision(decision("a1"));
        f.audit.decision(decision("a2", "deny"));
        return { block: true as const };
      },
    );
    await f.audit.run(
      f.ctx,
      { toolCallId: "b", toolName: "read" },
      async () => {
        f.audit.decision(decision("b1"));
        return {};
      },
    );
    release();
    await first;
    expect(f.saved.every(isPermissionAuditEntry)).toBe(true);
    expect(
      f.saved
        .filter((e) => e.requestId.startsWith("a"))
        .every((e) => e.toolCallId === "a" && e.parentToolCallId === "code"),
    ).toBe(true);
    expect(f.saved.find((e) => e.requestId === "b1")?.toolCallId).toBe("b");
    expect(
      f.saved.find((e) => e.requestId === "tool:a")?.final?.resolution,
    ).toBe("tool_blocked");
    expect(
      f.saved.filter((e) => e.requestId === "a1" && e.phase === "resolved"),
    ).toHaveLength(1);
  });
  it("keeps model verdict distinct from final human approval and masks named secrets", async () => {
    const f = fixture();
    await f.audit.run(
      f.ctx,
      { toolCallId: "a", toolName: "bash" },
      async () => {
        f.logger.review("permission_request.waiting", {
          requestId: "r",
          command: "SECRET=do-not-store curl example",
          toolInputPreview: "private contents",
        });
        f.logger.review("pi_auto_review_decision", {
          requestId: "r",
          reviewerOutcome: "defer",
          rationale: "token=private-value needs approval",
          attempts: 1,
          durationMs: 12,
          reviewerModel: "fixture",
        });
        f.audit.prompt({ requestId: "r" } as never);
        f.audit.decision({ ...decision("r"), resolution: "user_approved" });
        return {};
      },
    );
    const final = f.saved.find(
      (e) => e.requestId === "r" && e.phase === "resolved",
    )!;
    expect(final.review?.outcome).toBe("defer");
    expect(final.final?.source).toBe("human");
    expect(
      f.saved.filter((e) => e.requestId === "r").map((e) => e.phase),
    ).toEqual(["started", "reviewed", "awaiting_human", "resolved"]);
    expect(JSON.stringify(f.saved)).not.toMatch(
      /private-value|do-not-store|private contents/,
    );
  });
  it("cancellation prevents late observation from reviving a request", async () => {
    const f = fixture();
    await f.audit.run(f.ctx, { toolCallId: "a" }, async () => {
      f.logger.review("permission_request.waiting", { requestId: "r" });
      f.audit.interrupt();
      f.audit.decision(decision("r"));
      return { block: true as const };
    });
    expect(
      f.saved.filter((e) => e.requestId === "r" && e.phase === "resolved"),
    ).toHaveLength(1);
    expect(
      f.saved.find((e) => e.requestId === "r" && e.final)?.final?.resolution,
    ).toBe("cancelled");
  });
  it("a failed audit write cannot change authorization, and is visible", async () => {
    const f = fixture("s", true);
    const result = await f.audit.run(f.ctx, { toolCallId: "a" }, async () => {
      f.audit.decision(decision("r", "deny"));
      return { block: true };
    });
    expect(result.block).toBe(true);
    expect(f.saved).toHaveLength(0);
    expect(f.updates.every((e) => e.storage === "error")).toBe(true);
    expect(f.notices).toHaveLength(1);
  });
  it("reload invalidates old contexts and distinguishes the next generation", async () => {
    const f = fixture();
    await f.audit.run(f.ctx, { toolCallId: "old" }, async () => {
      f.logger.review("permission_request.waiting", { requestId: "old-r" });
      f.audit.activate(f.ctx);
      f.audit.decision(decision("old-r"));
      return {};
    });
    await f.audit.run(f.ctx, { toolCallId: "new" }, async () => {
      f.audit.decision(decision("new-r"));
      return {};
    });
    expect(
      f.saved.filter((e) => e.requestId === "old-r" && e.final),
    ).toHaveLength(1);
    expect(f.saved.find((e) => e.requestId === "old-r")?.generationId).not.toBe(
      f.saved.find((e) => e.requestId === "new-r")?.generationId,
    );
  });
  it("rejects malformed display entries and bounds reason strings", () => {
    expect(isPermissionAuditEntry({ schemaVersion: 9 })).toBe(false);
    expect(auditText("password=abc Bearer xyz")).not.toMatch(/abc|xyz/);
    expect(auditText("x".repeat(2000))).toHaveLength(800);
  });
});
