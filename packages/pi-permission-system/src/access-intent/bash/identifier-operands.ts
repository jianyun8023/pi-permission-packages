/**
 * Argument indices whose command grammar proves they are identifiers. This
 * only removes false path candidates; the bash gate still sees every word.
 * Unknown commands/options and ambiguous Git pathspecs keep generic handling.
 */
export function identifierOperandIndices(
  command: string,
  args: readonly string[],
): ReadonlySet<number> {
  const identifiers = new Set<number>();
  if (command === "tea") {
    if (!args.some((arg) => arg === "pulls" || arg === "pr"))
      return identifiers;
    const flags = new Set(["--repo", "-r", "--head", "--base"]);
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === "--" || arg === "<computed>") break;
      if (flags.has(arg.split("=")[0])) {
        if (arg.includes("=")) identifiers.add(index);
        else if (index + 1 < args.length) identifiers.add(++index);
      } else if (TEA_VALUE_FLAGS.has(arg) && index + 1 < args.length) {
        index++;
      }
    }
    return identifiers;
  }
  if (command !== "git") return identifiers;
  // A computed word can introduce -- or change option arity. In fetch's
  // multi-remote form every positional is a repository, potentially a path.
  if (args.includes("<computed>") || args.includes("--multiple"))
    return identifiers;
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
    else return identifiers;
  }
  const subcommand = args[start++];
  if (!subcommand || args.slice(start).includes("--no-index"))
    return identifiers;
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
  return identifiers;
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
