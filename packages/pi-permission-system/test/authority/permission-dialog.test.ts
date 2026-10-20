import { describe, expect, it, vi } from "vitest";
import {
  createDeniedPermissionDecision,
  isPermissionDecisionState,
  normalizePermissionDenialReason,
  type PermissionDecisionUi,
  requestPermissionDecisionFromUi,
} from "#src/authority/permission-dialog";

describe("isPermissionDecisionState", () => {
  it("accepts approved", () => {
    expect(isPermissionDecisionState("approved")).toBe(true);
  });

  it("accepts denied", () => {
    expect(isPermissionDecisionState("denied")).toBe(true);
  });

  it("accepts denied_with_reason", () => {
    expect(isPermissionDecisionState("denied_with_reason")).toBe(true);
  });

  it("accepts approved_for_session", () => {
    expect(isPermissionDecisionState("approved_for_session")).toBe(true);
  });

  it("accepts approved_for_serving_session", () => {
    expect(isPermissionDecisionState("approved_for_serving_session")).toBe(
      true,
    );
  });

  it("rejects unknown strings", () => {
    expect(isPermissionDecisionState("unknown")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isPermissionDecisionState(42)).toBe(false);
    expect(isPermissionDecisionState(null)).toBe(false);
  });
});

describe("requestPermissionDecisionFromUi", () => {
  it.each(["project", "global"] as const)(
    "offers an explicit %s command rule and records only the selected scope",
    async (scope) => {
      const commandRule = {
        command: "git fetch origin",
        project: "Yes, add to project allowlist: git fetch origin",
        global: "Yes, add to global allowlist: git fetch origin",
      };
      const ui: PermissionDecisionUi = {
        select: vi.fn().mockResolvedValue(commandRule[scope]),
        input: vi.fn(),
      };
      const result = await requestPermissionDecisionFromUi(
        ui,
        "Title",
        "Message",
        { commandRule },
      );
      expect(ui.select).toHaveBeenCalledWith(
        "Title\nMessage",
        [
          "Yes",
          "Yes, for this session",
          commandRule.project,
          commandRule.global,
          "No",
          "No, provide reason",
        ],
        { signal: undefined },
      );
      expect(result).toEqual({
        approved: true,
        state: "approved",
        saveCommandRule: scope,
      });
    },
  );

  it("does not accept a project rule selection when the project option is absent", async () => {
    const ui: PermissionDecisionUi = {
      select: vi
        .fn()
        .mockResolvedValue("Yes, add to project allowlist: git fetch origin"),
      input: vi.fn(),
    };
    expect(
      await requestPermissionDecisionFromUi(ui, "Title", "Message", {
        commandRule: {
          command: "git fetch origin",
          global: "Yes, add to global allowlist: git fetch origin",
        },
      }),
    ).toEqual({ approved: false, state: "denied" });
  });

  it("returns approved when user selects Yes", async () => {
    const ui: PermissionDecisionUi = {
      select: vi.fn().mockResolvedValue("Yes"),
      input: vi.fn(),
    };
    const result = await requestPermissionDecisionFromUi(
      ui,
      "Title",
      "Message",
    );
    expect(result).toEqual({ approved: true, state: "approved" });
  });

  it("returns approved_for_session when user selects session option", async () => {
    const ui: PermissionDecisionUi = {
      select: vi.fn().mockResolvedValue("Yes, for this session"),
      input: vi.fn(),
    };
    const result = await requestPermissionDecisionFromUi(
      ui,
      "Title",
      "Message",
    );
    expect(result).toEqual({ approved: true, state: "approved_for_session" });
  });

  it("returns denied when user selects No", async () => {
    const ui: PermissionDecisionUi = {
      select: vi.fn().mockResolvedValue("No"),
      input: vi.fn(),
    };
    const result = await requestPermissionDecisionFromUi(
      ui,
      "Title",
      "Message",
    );
    expect(result).toEqual({ approved: false, state: "denied" });
  });

  it("returns denied_with_reason when user provides reason", async () => {
    const ui: PermissionDecisionUi = {
      select: vi.fn().mockResolvedValue("No, provide reason"),
      input: vi.fn().mockResolvedValue("not now"),
    };
    const result = await requestPermissionDecisionFromUi(
      ui,
      "Title",
      "Message",
    );
    expect(result).toEqual({
      approved: false,
      state: "denied_with_reason",
      denialReason: "not now",
    });
  });

  it("returns denied when user selects deny-with-reason but gives empty input", async () => {
    const ui: PermissionDecisionUi = {
      select: vi.fn().mockResolvedValue("No, provide reason"),
      input: vi.fn().mockResolvedValue(""),
    };
    const result = await requestPermissionDecisionFromUi(
      ui,
      "Title",
      "Message",
    );
    expect(result).toEqual({ approved: false, state: "denied" });
  });

  it("returns denied when user dismisses dialog (undefined)", async () => {
    const ui: PermissionDecisionUi = {
      select: vi.fn().mockResolvedValue(undefined),
      input: vi.fn(),
    };
    const result = await requestPermissionDecisionFromUi(
      ui,
      "Title",
      "Message",
    );
    expect(result).toEqual({ approved: false, state: "denied" });
  });

  it("passes four options to ui.select", async () => {
    const selectFn = vi.fn().mockResolvedValue("Yes");
    const ui: PermissionDecisionUi = {
      select: selectFn,
      input: vi.fn(),
    };
    await requestPermissionDecisionFromUi(ui, "Title", "Message");
    const options = selectFn.mock.calls[0][1] as string[];
    expect(options).toEqual([
      "Yes",
      "Yes, for this session",
      "No",
      "No, provide reason",
    ]);
  });

  it("uses custom sessionLabel when provided", async () => {
    const selectFn = vi.fn().mockResolvedValue("Yes");
    const ui: PermissionDecisionUi = {
      select: selectFn,
      input: vi.fn(),
    };
    await requestPermissionDecisionFromUi(ui, "Title", "Message", {
      sessionLabel: 'Yes, allow "git *" for this session',
    });
    const options = selectFn.mock.calls[0][1] as string[];
    expect(options[1]).toBe('Yes, allow "git *" for this session');
  });

  it("still returns approved_for_session when user selects the custom session label", async () => {
    const customLabel = 'Yes, allow "git *" for this session';
    const ui: PermissionDecisionUi = {
      select: vi.fn().mockResolvedValue(customLabel),
      input: vi.fn(),
    };
    const result = await requestPermissionDecisionFromUi(
      ui,
      "Title",
      "Message",
      { sessionLabel: customLabel },
    );
    expect(result).toEqual({ approved: true, state: "approved_for_session" });
  });

  it("falls back to default session label when no options provided", async () => {
    const selectFn = vi.fn().mockResolvedValue("Yes");
    const ui: PermissionDecisionUi = {
      select: selectFn,
      input: vi.fn(),
    };
    await requestPermissionDecisionFromUi(ui, "Title", "Message");
    const options = selectFn.mock.calls[0][1] as string[];
    expect(options[1]).toBe("Yes, for this session");
  });

  describe("both-directions session grant (#813)", () => {
    const sessionWidth = {
      label: 'Yes, allow reads and writes to "/tmp/*" for this session',
    };

    it("offers the width option after the session option", async () => {
      const selectFn = vi.fn().mockResolvedValue("Yes");
      const ui: PermissionDecisionUi = { select: selectFn, input: vi.fn() };
      await requestPermissionDecisionFromUi(ui, "Title", "Message", {
        sessionLabel: 'Yes, allow writes to "/tmp/*" for this session',
        sessionWidth,
      });
      expect(selectFn.mock.calls[0][1]).toEqual([
        "Yes",
        'Yes, allow writes to "/tmp/*" for this session',
        sessionWidth.label,
        "No",
        "No, provide reason",
      ]);
    });

    it("returns the family width when the width option is chosen", async () => {
      const ui: PermissionDecisionUi = {
        select: vi.fn().mockResolvedValue(sessionWidth.label),
        input: vi.fn(),
      };
      expect(
        await requestPermissionDecisionFromUi(ui, "Title", "Message", {
          sessionWidth,
        }),
      ).toEqual({
        approved: true,
        state: "approved_for_session",
        sessionGrantWidth: "family",
      });
    });

    it("leaves the plain session option at the proven width", async () => {
      const ui: PermissionDecisionUi = {
        select: vi.fn().mockResolvedValue("Yes, for this session"),
        input: vi.fn(),
      };
      expect(
        await requestPermissionDecisionFromUi(ui, "Title", "Message", {
          sessionWidth,
        }),
      ).toEqual({ approved: true, state: "approved_for_session" });
    });

    it("continues into the scope select from the width option", async () => {
      const selectFn = vi
        .fn()
        .mockResolvedValueOnce(sessionWidth.label)
        .mockResolvedValueOnce("The whole session");
      const ui: PermissionDecisionUi = { select: selectFn, input: vi.fn() };
      const result = await requestPermissionDecisionFromUi(
        ui,
        "Title",
        "Message",
        {
          sessionWidth,
          sessionScope: {
            subagentLabel: "This subagent only",
            servingSessionLabel: "The whole session",
          },
        },
      );
      expect(selectFn).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        approved: true,
        state: "approved_for_serving_session",
        sessionGrantWidth: "family",
      });
    });
  });

  describe("sessionScope two-step (forwarded asks)", () => {
    const sessionScope = {
      subagentLabel: "This subagent only",
      servingSessionLabel: "The whole session",
    };

    it("opens a second scope select after the session option is chosen", async () => {
      const selectFn = vi
        .fn()
        .mockResolvedValueOnce("Yes, for this session")
        .mockResolvedValueOnce("This subagent only");
      const ui: PermissionDecisionUi = { select: selectFn, input: vi.fn() };
      await requestPermissionDecisionFromUi(ui, "Title", "Message", {
        sessionScope,
      });
      expect(selectFn).toHaveBeenCalledTimes(2);
      const scopeOptions = selectFn.mock.calls[1][1] as string[];
      expect(scopeOptions).toEqual(["This subagent only", "The whole session"]);
    });

    it("maps the subagent scope to approved_for_session", async () => {
      const ui: PermissionDecisionUi = {
        select: vi
          .fn()
          .mockResolvedValueOnce("Yes, for this session")
          .mockResolvedValueOnce("This subagent only"),
        input: vi.fn(),
      };
      const result = await requestPermissionDecisionFromUi(
        ui,
        "Title",
        "Message",
        { sessionScope },
      );
      expect(result).toEqual({ approved: true, state: "approved_for_session" });
    });

    it("maps the whole-session scope to approved_for_serving_session", async () => {
      const ui: PermissionDecisionUi = {
        select: vi
          .fn()
          .mockResolvedValueOnce("Yes, for this session")
          .mockResolvedValueOnce("The whole session"),
        input: vi.fn(),
      };
      const result = await requestPermissionDecisionFromUi(
        ui,
        "Title",
        "Message",
        { sessionScope },
      );
      expect(result).toEqual({
        approved: true,
        state: "approved_for_serving_session",
      });
    });

    it("defaults to the least-privilege subagent scope when the scope select is cancelled", async () => {
      const ui: PermissionDecisionUi = {
        select: vi
          .fn()
          .mockResolvedValueOnce("Yes, for this session")
          .mockResolvedValueOnce(undefined),
        input: vi.fn(),
      };
      const result = await requestPermissionDecisionFromUi(
        ui,
        "Title",
        "Message",
        { sessionScope },
      );
      expect(result).toEqual({ approved: true, state: "approved_for_session" });
    });

    it("does not open the scope select when the user picks plain Yes", async () => {
      const selectFn = vi.fn().mockResolvedValueOnce("Yes");
      const ui: PermissionDecisionUi = { select: selectFn, input: vi.fn() };
      const result = await requestPermissionDecisionFromUi(
        ui,
        "Title",
        "Message",
        { sessionScope },
      );
      expect(selectFn).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ approved: true, state: "approved" });
    });
  });

  describe("dismissal by an expired answer window", () => {
    /** A scripted answer that waits for the signal to dismiss it, as Pi's dialogs do. */
    const AWAIT_DISMISSAL = Symbol("await dismissal");
    type Scripted = string | undefined | typeof AWAIT_DISMISSAL;
    interface DialogOptions {
      signal?: AbortSignal;
    }

    function respond(
      queue: Scripted[],
      opts: DialogOptions | undefined,
    ): Promise<string | undefined> {
      const next = queue.shift();
      if (next !== AWAIT_DISMISSAL) {
        return Promise.resolve(next);
      }
      return new Promise((resolve) => {
        opts?.signal?.addEventListener(
          "abort",
          () => {
            resolve(undefined);
          },
          { once: true },
        );
      });
    }

    function scriptedUi(selects: Scripted[], inputs: Scripted[] = []) {
      const select = vi.fn(
        (_title: string, _options: string[], opts?: DialogOptions) =>
          respond(selects, opts),
      );
      const input = vi.fn(
        (_title: string, _placeholder?: string, opts?: DialogOptions) =>
          respond(inputs, opts),
      );
      const ui: PermissionDecisionUi = { select, input };
      return { ui, select, input };
    }

    async function dismissWhilePending(
      ui: PermissionDecisionUi,
      options?: Parameters<typeof requestPermissionDecisionFromUi>[3],
    ) {
      const window = new AbortController();
      const answer = requestPermissionDecisionFromUi(
        ui,
        "Title",
        "Message",
        options,
        window.signal,
      );
      await Promise.resolve();
      await Promise.resolve();
      window.abort();
      return answer;
    }

    it("hands the signal to the select, so the host can dismiss it", async () => {
      const { ui, select } = scriptedUi(["Yes"]);
      const window = new AbortController();

      await requestPermissionDecisionFromUi(
        ui,
        "Title",
        "Message",
        undefined,
        window.signal,
      );

      expect(select).toHaveBeenCalledWith("Title\nMessage", expect.any(Array), {
        signal: window.signal,
      });
    });

    it("answers nothing when the window dismisses the decision select", async () => {
      const { ui } = scriptedUi([AWAIT_DISMISSAL]);
      expect(await dismissWhilePending(ui)).toBeUndefined();
    });

    it("answers nothing when the window dismisses the scope select", async () => {
      const { ui } = scriptedUi(["Yes, for this session", AWAIT_DISMISSAL]);
      expect(
        await dismissWhilePending(ui, {
          sessionScope: {
            subagentLabel: "This subagent only",
            servingSessionLabel: "The whole session",
          },
        }),
      ).toBeUndefined();
    });

    it("answers nothing when the window dismisses the reason input", async () => {
      const { ui } = scriptedUi(["No, provide reason"], [AWAIT_DISMISSAL]);
      expect(await dismissWhilePending(ui)).toBeUndefined();
    });

    it("still denies a select the human cancelled while the window was open", async () => {
      const { ui } = scriptedUi([undefined]);
      const window = new AbortController();

      const result = await requestPermissionDecisionFromUi(
        ui,
        "Title",
        "Message",
        undefined,
        window.signal,
      );

      expect(result).toEqual({ approved: false, state: "denied" });
    });
  });
});

describe("normalizePermissionDenialReason", () => {
  it("returns trimmed string for non-empty input", () => {
    expect(normalizePermissionDenialReason("  reason  ")).toBe("reason");
  });

  it("returns undefined for empty string", () => {
    expect(normalizePermissionDenialReason("")).toBeUndefined();
  });

  it("returns undefined for non-string", () => {
    expect(normalizePermissionDenialReason(42)).toBeUndefined();
  });
});

describe("createDeniedPermissionDecision", () => {
  it("returns denied_with_reason when reason provided", () => {
    expect(createDeniedPermissionDecision("nope")).toEqual({
      approved: false,
      state: "denied_with_reason",
      denialReason: "nope",
    });
  });

  it("returns denied when no reason", () => {
    expect(createDeniedPermissionDecision()).toEqual({
      approved: false,
      state: "denied",
    });
  });
});
