import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CommandRuleStore,
  isExactCommandRule,
} from "#src/config/command-rule-store";
import {
  getGlobalConfigPath,
  getProjectConfigPath,
} from "#src/config/config-paths";
import { PermissionManager } from "#src/policy/permission-manager";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-command-rules-"));
  directories.push(root);
  const agentDir = join(root, "agent"),
    cwd = join(root, "project"),
    otherCwd = join(root, "other");
  for (const directory of [agentDir, cwd, otherCwd]) mkdirSync(directory);
  const global = getGlobalConfigPath(agentDir),
    project = getProjectConfigPath(cwd);
  const write = (file: string, value: unknown) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  };
  write(global, {
    permission: {
      "*": "ask",
      bash: { "*": "ask", "git push *": "deny" },
      path: { "*.env": "deny" },
    },
    debugLog: false,
  });
  const store = new CommandRuleStore(agentDir);
  const check = (directory: string, command = "git fetch origin") => {
    const manager = new PermissionManager({ agentDir });
    manager.configureForCwd(directory);
    return manager.check({
      kind: "bash-command",
      surface: "bash",
      command,
      spellings: [],
    }).state;
  };
  return {
    root,
    agentDir,
    cwd,
    otherCwd,
    global,
    project,
    write,
    store,
    check,
  };
}

describe("CommandRuleStore", () => {
  it("refreshes an existing manager on the next call after a rule is saved", () => {
    const f = fixture(),
      manager = new PermissionManager({ agentDir: f.agentDir });
    manager.configureForCwd(f.cwd);
    const intent = {
      kind: "bash-command" as const,
      surface: "bash",
      command: "git fetch origin",
      spellings: [],
    };
    expect(manager.check(intent).state).toBe("ask");
    f.store.save({
      scope: "project",
      cwd: f.cwd,
      projectTrusted: true,
      command: intent.command,
    });
    expect(manager.check(intent).state).toBe("allow");
  });
  it("persists a project rule across managers without allowing another project or overwriting global policy", () => {
    const f = fixture(),
      before = readFileSync(f.global, "utf8");
    expect(f.check(f.cwd)).toBe("ask");
    expect(
      f.store.save({
        scope: "project",
        cwd: f.cwd,
        projectTrusted: true,
        command: "git fetch origin",
      }),
    ).toBe(f.project);
    expect(f.check(f.cwd)).toBe("allow");
    expect(f.check(f.otherCwd)).toBe("ask");
    expect(f.check(f.cwd, "git fetch upstream")).toBe("ask");
    expect(f.check(f.cwd, "git push origin")).toBe("deny");
    expect(readFileSync(f.global, "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(f.project, "utf8"))).toEqual({
      permission: { bash: { "git fetch origin": "allow" } },
    });
  });

  it("makes a global rule available to another project and preserves unrelated settings", () => {
    const f = fixture();
    f.store.save({
      scope: "global",
      cwd: f.cwd,
      projectTrusted: true,
      command: "git fetch origin",
    });
    expect(f.check(f.cwd)).toBe("allow");
    expect(f.check(f.otherCwd)).toBe("allow");
    expect(JSON.parse(readFileSync(f.global, "utf8"))).toEqual({
      debugLog: false,
      permission: {
        "*": "ask",
        bash: { "*": "ask", "git push *": "deny", "git fetch origin": "allow" },
        path: { "*.env": "deny" },
      },
    });
    expect(statSync(f.global).mode & 0o777).toBe(0o600);
  });

  it("keeps path denies active after saving a command", () => {
    const f = fixture();
    f.store.save({
      scope: "project",
      cwd: f.cwd,
      projectTrusted: true,
      command: "cat .env",
    });
    const manager = new PermissionManager({ agentDir: f.agentDir });
    manager.configureForCwd(f.cwd);
    expect(
      manager.check({
        kind: "path-values",
        surface: "path_read",
        values: [".env"],
      }).state,
    ).toBe("deny");
  });

  it("retains a project scalar fallback when adding an exact exception", () => {
    const f = fixture();
    f.write(f.project, {
      permission: { bash: "ask", edit: "deny" },
      promptTimeoutMs: 20000,
    });
    f.store.save({
      scope: "project",
      cwd: f.cwd,
      projectTrusted: true,
      command: "git fetch origin",
    });
    expect(JSON.parse(readFileSync(f.project, "utf8"))).toEqual({
      permission: {
        bash: { "*": "ask", "git fetch origin": "allow" },
        edit: "deny",
      },
      promptTimeoutMs: 20000,
    });
    expect(f.check(f.cwd)).toBe("allow");
    expect(f.check(f.cwd, "git fetch upstream")).toBe("ask");
  });

  it.each(["project", "global"] as const)(
    "does not override a matching deny when saving to %s",
    (scope) => {
      const f = fixture(),
        before = readFileSync(f.global, "utf8");
      expect(() =>
        f.store.save({
          scope,
          cwd: f.cwd,
          projectTrusted: true,
          command: "git push origin",
        }),
      ).toThrow("deny");
      expect(readFileSync(f.global, "utf8")).toBe(before);
      expect(existsSync(f.project)).toBe(false);
    },
  );

  it("refuses a rule after project trust is revoked", () => {
    const f = fixture();
    expect(() =>
      f.store.save({
        scope: "project",
        cwd: f.cwd,
        projectTrusted: false,
        command: "git fetch origin",
      }),
    ).toThrow("Trust");
    expect(existsSync(f.project)).toBe(false);
  });

  it("preserves an invalid file rather than replacing it with an allow rule", () => {
    const f = fixture();
    f.write(f.project, { unknownSetting: true });
    const before = readFileSync(f.project, "utf8");
    expect(() =>
      f.store.save({
        scope: "project",
        cwd: f.cwd,
        projectTrusted: true,
        command: "git fetch origin",
      }),
    ).toThrow("invalid");
    expect(readFileSync(f.project, "utf8")).toBe(before);
    expect(existsSync(`${f.project}.command-rule-lock`)).toBe(false);
  });

  it("does not follow a project config symlink or write to the linked global file", () => {
    const f = fixture();
    mkdirSync(dirname(f.project), { recursive: true });
    symlinkSync(f.global, f.project);
    const before = readFileSync(f.global, "utf8");
    expect(() =>
      f.store.save({
        scope: "project",
        cwd: f.cwd,
        projectTrusted: true,
        command: "git fetch origin",
      }),
    ).toThrow("symbolic link");
    expect(readFileSync(f.global, "utf8")).toBe(before);
  });

  it("does not overwrite a concurrent writer's lock or config", () => {
    const f = fixture();
    mkdirSync(`${f.global}.command-rule-lock`);
    const before = readFileSync(f.global, "utf8");
    expect(() =>
      f.store.save({
        scope: "global",
        cwd: f.cwd,
        projectTrusted: true,
        command: "git fetch origin",
      }),
    ).toThrow();
    expect(readFileSync(f.global, "utf8")).toBe(before);
    expect(existsSync(`${f.global}.command-rule-lock`)).toBe(true);
  });
});

describe("exact command eligibility", () => {
  it.each([
    "git fetch origin",
    "pnpm test",
    "tea pulls list --repo org/repo",
    "git commit -m 'fix title'",
  ])("accepts %s", (command) => {
    expect(isExactCommandRule(command)).toBe(true);
  });
  it.each([
    "",
    "git *",
    "echo ?",
    "echo $TOKEN",
    "A=1 pnpm test",
    "git fetch; git push",
    "echo x > file",
    "echo `date`",
    "pnpm test\necho ok",
    "x".repeat(513),
  ])("rejects unsafe-to-save syntax %s", (command) => {
    expect(isExactCommandRule(command)).toBe(false);
  });
});
