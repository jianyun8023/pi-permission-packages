import type { PromptPayload } from "#src/presentation/prompt-payload";
import type { PermissionPromptUi } from "./permission-prompt-component";

const CAPABILITY = Symbol.for("pi-permissions:rpc-reviewed-approval/v1");

/** Consume only a trusted in-process reviewer's exact one-use RPC receipt. */
export function consumeRpcReviewedApproval(
  ui: PermissionPromptUi,
  requestId: string | undefined,
  payload: PromptPayload,
): boolean {
  if (!requestId) return false;
  try {
    const capability = (ui as unknown as Record<symbol, unknown>)[CAPABILITY];
    if (!capability || typeof capability !== "object") return false;
    const candidate = capability as { version?: unknown; consume?: unknown };
    return (
      candidate.version === 1 &&
      typeof candidate.consume === "function" &&
      (candidate.consume as (id: string, payload: PromptPayload) => unknown)(
        requestId,
        payload,
      ) === true
    );
  } catch {
    return false;
  }
}
