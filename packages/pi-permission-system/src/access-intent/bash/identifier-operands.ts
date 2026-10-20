/**
 * Argument indices whose command grammar proves they are identifiers. This
 * only removes false path candidates; the bash gate still sees every word.
 * Unknown commands/options and ambiguous Git pathspecs keep generic handling.
 */
export function identifierOperandIndices(
  command: string,
  args: readonly string[],
): {
  identifiers: ReadonlySet<number>;
  repositories: ReadonlyMap<number, string>;
} {
  const identifiers = new Set<number>();
  const repositories = new Map<number, string>();
  if (command === "docker")
    return { identifiers: containerExecOperandIndices(args), repositories };
  if (command === "tea") {
    if (
      !args.some((arg) => ["pulls", "pr", "comments", "comment"].includes(arg))
    )
      return { identifiers, repositories };
    const flags = new Set(["--repo", "-r", "--head", "--base"]);
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === "--" || arg === "<computed>") break;
      if (flags.has(arg.split("=")[0])) {
        const flag = arg.split("=")[0];
        const valueIndex = arg.includes("=") ? index : ++index;
        const value = arg.includes("=")
          ? arg.slice(arg.indexOf("=") + 1)
          : args[valueIndex];
        // --repo prefers an existing local checkout even for owner/repo syntax.
        // Keep that ambiguity for the resolver's effective-cwd existence probe.
        if (
          value &&
          (!["--repo", "-r"].includes(flag) ||
            /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(
              value,
            ))
        ) {
          identifiers.add(valueIndex);
          if (["--repo", "-r"].includes(flag))
            repositories.set(valueIndex, value);
        }
      } else if (TEA_VALUE_FLAGS.has(arg) && index + 1 < args.length) {
        index++;
      }
    }
    return { identifiers, repositories };
  }
  if (command !== "git") return { identifiers, repositories };
  // A computed word can introduce -- or change option arity. In fetch's
  // multi-remote form every positional is a repository, potentially a path.
  if (args.includes("<computed>") || args.includes("--multiple"))
    return { identifiers, repositories };
  let start = 0;
  while (args[start]?.startsWith("-")) {
    const arg = args[start];
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(arg))
      start += 2;
    else if (
      /^(?:--(?:git-dir|work-tree|namespace)=|-[Cc].+)/.test(arg) ||
      ["--no-pager", "--paginate", "--bare", "--no-optional-locks"].includes(
        arg,
      )
    )
      start++;
    else return { identifiers, repositories };
  }
  const subcommand = args[start++];
  if (!subcommand || args.slice(start).includes("--no-index"))
    return { identifiers, repositories };
  let positional = 0;
  for (let index = start; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") break;
    if (
      (subcommand === "checkout" && ["-b", "-B", "--orphan"].includes(arg)) ||
      (subcommand === "switch" && ["-c", "-C", "--orphan"].includes(arg))
    ) {
      if (index + 1 < args.length) identifiers.add(++index);
      continue;
    }
    if (arg.startsWith("-")) {
      // Unknown options may consume a file name. Never reinterpret that value
      // as a revision, even when its spelling resembles one.
      if (
        !arg.includes("=") &&
        !GIT_BOOLEAN_FLAGS.has(arg) &&
        !/^-[0-9]+$/.test(arg)
      )
        break;
      continue;
    }
    if (
      (["push", "fetch"].includes(subcommand) && positional > 0) ||
      subcommand === "rev-list" ||
      subcommand === "branch" ||
      (["diff", "log", "show"].includes(subcommand) && isRevisionRange(arg))
    ) {
      identifiers.add(index);
    }
    positional++;
  }
  return { identifiers, repositories };
}

/** Docker exec operands belong to the container; env-file and shell redirects
 * still belong to the host. Unknown option arity retains generic projection.
 * The token collector independently descends host command substitutions.
 */
function containerExecOperandIndices(
  args: readonly string[],
): ReadonlySet<number> {
  const skipped = new Set<number>();
  let index = args[0] === "container" ? 1 : 0;
  if (args[index++] !== "exec") return skipped;
  for (; index < args.length; index++) {
    const arg = args[index];
    if (hasShellExpansion(arg)) return new Set();
    if (arg === "--") {
      index++;
      break;
    }
    if (!arg.startsWith("-")) break;
    if (
      /^-[dit]+$/.test(arg) ||
      ["--detach", "--interactive", "--tty", "--privileged"].includes(arg)
    )
      continue;
    const flag = arg.split("=")[0];
    if (
      [
        "--env-file",
        "--env",
        "--user",
        "--workdir",
        "--detach-keys",
        "-e",
        "-u",
        "-w",
      ].includes(flag)
    ) {
      const valueIndex = arg.includes("=") ? index : ++index;
      if (valueIndex >= args.length || hasShellExpansion(args[valueIndex]))
        return new Set();
      if (flag !== "--env-file") skipped.add(valueIndex);
    } else if (/^-[euw].+/.test(arg)) skipped.add(index);
    else return new Set();
  }
  if (
    !args[index] ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(args[index]) ||
    !args[index + 1]
  )
    return new Set();
  for (; index < args.length; index++) skipped.add(index);
  return skipped;
}

function hasShellExpansion(value: string): boolean {
  // isComputed does not cover brace expansion or ANSI-C quoting. An expansion
  // can inject a Docker option before its container, changing host-file arity.
  for (const character of value) {
    if ("$`{}[]*?\\~()<>".includes(character)) return true;
  }
  return false;
}

function isRevisionRange(value: string): boolean {
  // These are revision operators, not an arbitrary slash-bearing branch or
  // path. Explicit ./ and ../ operands retain their file interpretation.
  return (
    !/^(?:\/|\.\.?\/)/.test(value) &&
    /^[^\s.]+(?:\.[^.]+)*\.{2,3}[^\s]+$/.test(value)
  );
}

const TEA_VALUE_FLAGS = new Set([
  "--description",
  "-d",
  "--description-file",
  "--title",
  "-t",
  "--login",
  "-l",
  "--output",
  "-o",
  "--labels",
  "--assignees",
  "--milestone",
  "--reviewers",
]);

const GIT_BOOLEAN_FLAGS = new Set([
  "--count",
  "--left-right",
  "--left-only",
  "--right-only",
  "--cherry-pick",
  "--oneline",
  "--stat",
  "--shortstat",
  "--name-only",
  "--name-status",
  "--raw",
  "--patch",
  "-p",
  "--no-patch",
  "-s",
  "--quiet",
  "-q",
  "--exit-code",
  "--cached",
  "--staged",
  "--no-ext-diff",
  "--ext-diff",
  "--no-textconv",
  "--textconv",
  "--all",
  "--tags",
  "--branches",
  "--remotes",
  "--decorate",
  "--no-decorate",
  "--reverse",
  "--topo-order",
  "--date-order",
  "--graph",
  "--no-merges",
  "--merges",
  "--dry-run",
  "-n",
  "--set-upstream",
  "-u",
  "--force",
  "-f",
  "--force-with-lease",
  "--delete",
  "-d",
  "-D",
  "--prune",
  "--atomic",
  "--verbose",
  "-v",
  "--list",
]);
