import type {
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  type CommandRuleScope,
  type CommandRuleStore,
  isExactCommandRule,
} from "#src/config/command-rule-store";
import type { ReviewLogger } from "#src/logging/session-logger";
import type {
  PermissionPromptDecision,
  RequestPermissionOptions,
} from "./permission-dialog";
import type { PromptPermissionDetails } from "./permission-prompter";

type CommandRuleOffer = NonNullable<RequestPermissionOptions["commandRule"]>;

/** Local human approval is the only producer of a persistent command rule. */
export class CommandRulePrompt {
  constructor(
    private readonly ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted"> & {
      ui: Pick<ExtensionUIContext, "notify">;
    },
    private readonly store: Pick<CommandRuleStore, "save">,
    private readonly logger: ReviewLogger,
  ) {}

  offer(details: PromptPermissionDetails): CommandRuleOffer | undefined {
    const { request } = details.payload;
    const command = request.value;
    if (
      details.forwarding ||
      details.agentName ||
      request.requester.forwarded ||
      request.requester.agentName ||
      details.payload.kind !== "bash" ||
      request.surface !== "bash" ||
      request.toolName !== "bash" ||
      request.commandContext ||
      request.executedUnit ||
      details.payload.evidence.some((item) => item.label === "full command") ||
      details.accessIntent?.floor ||
      request.matchedPattern?.startsWith("<") ||
      details.command !== command ||
      !isExactCommandRule(command) ||
      details.accessIntent?.askingUnits?.some(
        (unit) => unit.floor !== undefined,
      )
    )
      return;
    return {
      command,
      ...(this.ctx.isProjectTrusted()
        ? { project: `Yes, add to project allowlist: ${command}` }
        : {}),
      global: `Yes, add to global allowlist: ${command}`,
    };
  }

  save(
    details: PromptPermissionDetails,
    scope: CommandRuleScope,
  ): PermissionPromptDecision | undefined {
    try {
      // Revalidate after the dialog; a trust change cannot inherit an old offer.
      const offer = this.offer(details);
      if (!offer || (scope === "project" && !offer.project))
        throw new Error("This command is no longer eligible for a saved rule.");
      const configPath = this.store.save({
        scope,
        command: offer.command,
        cwd: this.ctx.cwd,
        projectTrusted: this.ctx.isProjectTrusted(),
      });
      this.logger.review("command_rule.saved", {
        requestId: details.requestId,
        scope,
        command: offer.command,
        configPath,
      });
      this.ctx.ui.notify(
        `Saved ${scope} command rule: ${offer.command}\n${configPath}\nPath restrictions and other permission gates still apply.`,
        "info",
      );
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = `Command rule was not saved; this call was not approved. ${message}`;
      this.logger.review("command_rule.save_failed", {
        requestId: details.requestId,
        scope,
        reason,
      });
      this.ctx.ui.notify(reason, "error");
      return {
        approved: false,
        state: "denied",
        confirmationUnavailable: true,
        denialReason: reason,
        decidedBy: { kind: "unavailable", reason },
      };
    }
  }
}

export type CommandRulePromptApi = Pick<CommandRulePrompt, "offer" | "save">;
