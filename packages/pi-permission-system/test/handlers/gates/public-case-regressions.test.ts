import { describe, expect, it } from "vitest";
import { BashProgram } from "#src/access-intent/bash/program";
import { describeBashPathGate } from "#src/handlers/gates/bash-path";
import { isGateDescriptor } from "#src/handlers/gates/descriptor";
import { posixPathFlavor } from "#src/path/path-flavor";
import { PathNormalizer } from "#src/path/path-normalizer";
import { PermissionResolver } from "#src/policy/permission-resolver";
import { SessionRules } from "#src/session/session-rules";
import { makeTcc } from "#test/helpers/gate-fixtures";
import { createInMemoryManager } from "#test/helpers/manager-harness";

// Equivalent Pi fixtures inspired by the public Claude issue; no shell runs.
// https://github.com/anthropics/claude-code/issues/91650
const publicCases = [
  ["cd /repo && sed -n '1,20p' src/main.ts; echo done", "allow"],
  ["cd /repo; sed -n '1,20p' src/main.ts", "allow"],
  ["cd /repo && grep -rn pattern src | head -20", "allow"],
  ["cd /repo && sed -n '1,20p' .env; echo done", "deny"],
  ["cd /repo; cat .env", "deny"],
  ["cd /repo && grep -rn pattern .env | head -20", "deny"],
  ["cat src/main.ts .env", "deny"],
  ["echo result > .env", "deny"],
] as const;
describe("public case equivalents keep sensitive denies and understand cd-relative reads", () => {
  it.each(publicCases)("%s => %s", async (command, expected) => {
    const manager = createInMemoryManager({
      global: {
        permission: {
          path_read: { "*": "allow", "/repo/.env": "deny", "*.env": "deny" },
          path_write: { "*": "ask", "*.env": "deny" },
        },
      },
    });
    manager.configureForCwd("/repo");
    const resolver = new PermissionResolver(manager, new SessionRules());
    const normalizer = new PathNormalizer(posixPathFlavor, "/repo");
    const program = await BashProgram.parse(command, normalizer);
    const gate = describeBashPathGate(
      makeTcc({ cwd: "/repo", input: { command } }),
      program,
      resolver,
      normalizer,
    );
    if (expected === "deny") {
      expect(isGateDescriptor(gate)).toBe(true);
      if (isGateDescriptor(gate)) expect(gate.preCheck?.state).toBe("deny");
    } else
      expect(isGateDescriptor(gate) ? gate.preCheck?.state : "allow").toBe(
        "allow",
      );
  });
});
