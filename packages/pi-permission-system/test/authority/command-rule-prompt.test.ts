import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AskDialogQueue } from "#src/authority/ask-dialog-queue";
import { CommandRulePrompt } from "#src/authority/command-rule-prompt";
import { LocalUserAuthorizer } from "#src/authority/local-user-authorizer";
import type { PermissionPromptDecision } from "#src/authority/permission-dialog";
import { requestPermissionDecision } from "#src/authority/permission-prompt-component";
import type { PromptPermissionDetails } from "#src/authority/permission-prompter";
import { CommandRuleStore } from "#src/config/command-rule-store";
import {
  getGlobalConfigPath,
  getProjectConfigPath,
} from "#src/config/config-paths";
import {
  makePromptDetails,
  makePromptPayload,
} from "#test/helpers/prompt-details-fixtures";
import { makePromptPreferences } from "#test/helpers/prompt-view-fixtures";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function details(command = "git fetch origin"): PromptPermissionDetails {
  const payload = makePromptPayload();
  return makePromptDetails({
    command,
    toolName: "bash",
    payload: {
      ...payload,
      kind: "bash",
      request: {
        ...payload.request,
        surface: "bash",
        toolName: "bash",
        value: command,
        matchedPattern: "*",
      },
    },
    accessIntent: {
      surface: "bash",
      matchValues: [command],
      boundaryValue: null,
      askingUnits: [{ command }],
    },
  });
}

function fixture(selected = "Yes, add to project allowlist: git fetch origin") {
  const root = mkdtempSync(join(tmpdir(), "pi-command-prompt-"));
  directories.push(root);
  const cwd = join(root, "project"),
    agentDir = join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  const global = getGlobalConfigPath(agentDir),
    project = getProjectConfigPath(cwd);
  mkdirSync(dirname(global), { recursive: true });
  writeFileSync(
    global,
    JSON.stringify({ permission: { "*": "ask", bash: { "*": "ask" } } }),
  );
  const isProjectTrusted = vi.fn(() => true),
    notify = vi.fn(),
    review = vi.fn();
  const commandRules = new CommandRulePrompt(
    { cwd, isProjectTrusted, ui: { notify } },
    new CommandRuleStore(agentDir),
    { review },
  );
  const ui = {
    select: vi.fn().mockResolvedValue(selected),
    input: vi.fn(),
    custom: vi.fn(),
    getToolsExpanded: vi.fn(() => false),
    setToolsExpanded: vi.fn(),
  };
  const deps = {
    ui,
    mode: "rpc" as const,
    events: { emit: vi.fn(), on: vi.fn() },
    dialogs: new AskDialogQueue(),
    getPromptPreferences: () => makePromptPreferences(),
    requestPermissionDecision,
    describeSession: () => ({ cwd, name: "allowlist test" }),
    commandRules,
  };
  return {
    cwd,
    project,
    global,
    deps,
    commandRules,
    ui,
    isProjectTrusted,
    notify,
    review,
  };
}

describe("local command-rule approval", () => {
  it.each(["project", "global"] as const)(
    "saves a %s rule only after a real RPC human selection",
    async (scope) => {
      const f = fixture(`Yes, add to ${scope} allowlist: git fetch origin`);
      const result = await new LocalUserAuthorizer(f.deps).authorize(details());
      expect(result).toEqual({
        approved: true,
        state: "approved",
        saveCommandRule: scope,
        decidedBy: { kind: "user", via: "select" },
      });
      const target = scope === "project" ? f.project : f.global;
      expect(
        JSON.parse(readFileSync(target, "utf8")).permission.bash[
          "git fetch origin"
        ],
      ).toBe("allow");
      expect(f.review).toHaveBeenCalledWith("command_rule.saved", {
        requestId: "req-1",
        scope,
        command: "git fetch origin",
        configPath: target,
      });
    },
  );

  it.each(["Yes", "Yes, for this session", "No", undefined])(
    "does not persist an ordinary choice: %s",
    async (selection) => {
      const f = fixture();
      f.ui.select.mockResolvedValue(selection);
      const before = readFileSync(f.global, "utf8");
      await new LocalUserAuthorizer(f.deps).authorize(details());
      expect(existsSync(f.project)).toBe(false);
      expect(readFileSync(f.global, "utf8")).toBe(before);
      expect(f.review).not.toHaveBeenCalled();
    },
  );

  it("does not offer a project rule in an untrusted project", () => {
    const f = fixture();
    f.isProjectTrusted.mockReturnValue(false);
    expect(f.commandRules.offer(details())).toEqual({
      command: "git fetch origin",
      global: "Yes, add to global allowlist: git fetch origin",
    });
  });

  it("fails closed if trust is revoked while the selection is open", async () => {
    const f = fixture();
    f.ui.select.mockImplementation(async () => {
      f.isProjectTrusted.mockReturnValue(false);
      return "Yes, add to project allowlist: git fetch origin";
    });
    const result = await new LocalUserAuthorizer(f.deps).authorize(details());
    expect(result.approved).toBe(false);
    expect(result.decidedBy.kind).toBe("unavailable");
    expect(existsSync(f.project)).toBe(false);
    expect(f.notify).toHaveBeenCalledWith(
      expect.stringContaining("not saved"),
      "error",
    );
  });

  it("refuses a model decision that tries to request persistence", async () => {
    const f = fixture();
    const decision: PermissionPromptDecision = {
      approved: true,
      state: "approved",
      saveCommandRule: "global",
      decidedBy: {
        kind: "authorizer",
        name: "model",
        verdict: "allow",
        reason: null,
      },
    };
    const authorizer = new LocalUserAuthorizer({
      ...f.deps,
      requestPermissionDecision: vi.fn().mockResolvedValue(decision),
    });
    const before = readFileSync(f.global, "utf8");
    expect((await authorizer.authorize(details())).approved).toBe(false);
    expect(readFileSync(f.global, "utf8")).toBe(before);
  });

  it.each([
    [
      "subagent",
      (d: PromptPermissionDetails) => {
        d.agentName = "worker";
      },
    ],
    [
      "forwarded",
      (d: PromptPermissionDetails) => {
        d.forwarding = {
          requesterAgentName: "worker",
          requesterSessionId: "child",
        };
      },
    ],
    [
      "wrapper floor",
      (d: PromptPermissionDetails) => {
        if (d.accessIntent) d.accessIntent.floor = "<opaque-bash-wrapper>";
      },
    ],
    [
      "another asking unit's floor",
      (d: PromptPermissionDetails) => {
        if (d.accessIntent)
          d.accessIntent.askingUnits = [
            { command: "eval x", floor: "<opaque-bash-wrapper>" },
          ];
      },
    ],
    [
      "path gate",
      (d: PromptPermissionDetails) => {
        d.payload = {
          ...d.payload,
          kind: "path",
          request: { ...d.payload.request, surface: "path_write" },
        };
      },
    ],
    [
      "compound command",
      (d: PromptPermissionDetails) => {
        d.payload = {
          ...d.payload,
          evidence: [
            {
              label: "full command",
              text: "git fetch origin && git push origin",
              detail: null,
            },
          ],
        };
      },
    ],
  ] as const)("does not offer durable approval for %s", (_name, change) => {
    const f = fixture(),
      d = details();
    change(d);
    expect(f.commandRules.offer(d)).toBeUndefined();
  });
});
