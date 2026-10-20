import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { wildcardMatch } from "#src/policy/wildcard-matcher";
import {
  type FlatPermissionConfig,
  isDenyWithReason,
  type PatternValue,
} from "#src/types";
import {
  loadUnifiedConfig,
  type UnifiedPermissionConfig,
} from "./config-loader";
import { getGlobalConfigPath, getProjectConfigPath } from "./config-paths";

export type CommandRuleScope = "project" | "global";

export interface CommandRuleWrite {
  scope: CommandRuleScope;
  command: string;
  cwd: string;
  projectTrusted: boolean;
}

/** Existing permission.bash rules are the only durable command allowlist. */
export class CommandRuleStore {
  constructor(private readonly agentDir: string) {}

  save(request: CommandRuleWrite): string {
    if (!isExactCommandRule(request.command))
      throw new Error("This command cannot be saved as an exact rule.");
    if (request.scope === "project" && !request.projectTrusted)
      throw new Error("Trust the project before saving a project rule.");
    const globalPath = getGlobalConfigPath(this.agentDir);
    const projectPath = getProjectConfigPath(request.cwd);
    const target = request.scope === "global" ? globalPath : projectPath;
    const root = request.scope === "global" ? this.agentDir : request.cwd;
    rejectSymlinks(root, target);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const lock = `${target}.command-rule-lock`;
    // A second process must retry, rather than overwrite a concurrent approval.
    mkdirSync(lock, { mode: 0o700 });
    const temporary = join(
      dirname(target),
      `.command-rule-${randomUUID()}.tmp`,
    );
    try {
      const global = readConfig(globalPath);
      const project = request.projectTrusted ? readConfig(projectPath) : {};
      for (const config of [global, project])
        assertNoDeny(config.permission, request.command);
      const existing = request.scope === "global" ? global : project;
      const permission = { ...existing.permission };
      const bash = permission.bash;
      const patterns: Record<string, PatternValue> =
        typeof bash === "string" ? { "*": bash } : { ...bash };
      // Reinsert an existing exact ask last, preserving every other rule.
      const retained = Object.fromEntries(
        Object.entries(patterns).filter(
          ([command]) => command !== request.command,
        ),
      );
      const updated = {
        ...existing,
        permission: {
          ...permission,
          bash: { ...retained, [request.command]: "allow" as const },
        },
      };
      writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, target);
      return target;
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        /* No temporary file after rename. */
      }
      rmdirSync(lock);
    }
  }
}

/** Wildcards, shell composition, expansion and assignments are not exact command rules. */
export function isExactCommandRule(command: string): boolean {
  return (
    command.length > 0 &&
    command.length <= 512 &&
    command.trim() === command &&
    Array.from(command).every(
      (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
    ) &&
    !/[*?$`;&|<>]/.test(command) &&
    !/^[A-Za-z_][A-Za-z_0-9]*=/.test(command)
  );
}

function readConfig(file: string): UnifiedPermissionConfig {
  const loaded = loadUnifiedConfig(file);
  if (loaded.issues.length > 0)
    throw new Error(
      `Cannot save a command rule while configuration is invalid: ${file}`,
    );
  return loaded.config;
}

function assertNoDeny(
  permission: FlatPermissionConfig | undefined,
  command: string,
): void {
  if (!permission) return;
  if (permission["*"] === "deny")
    throw new Error("A deny rule prevents saving this command.");
  const bash = permission.bash;
  if (bash === "deny")
    throw new Error("A bash deny rule prevents saving this command.");
  if (typeof bash !== "object") return;
  for (const [pattern, value] of Object.entries(bash)) {
    if (
      (value === "deny" || isDenyWithReason(value)) &&
      wildcardMatch(pattern, command)
    ) {
      throw new Error(
        "A matching bash deny rule prevents saving this command.",
      );
    }
  }
}

function rejectSymlinks(root: string, target: string): void {
  let current = resolve(root);
  for (const part of relative(current, target).split(/[\\/]/)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new Error(
          "Cannot save permission rules through a symbolic link.",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
