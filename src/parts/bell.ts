/**
 * Bell Extension
 *
 * Rings the terminal bell (\a) when the pi agent settles and waits for input,
 * so luna knows her attention is needed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Ring the terminal bell once. Shared by every part that blocks on a dialog
 * mid-turn (ask, plan_submit, the sandbox approval gate).
 *
 * isTTY guard: a bare BEL is only meaningful (and safe) on a real terminal.
 * Under --mode rpc (subagent workers) stdout is a JSONL control channel — a
 * stray byte would corrupt frame parsing (see rpc-process.ts, which treats
 * non-JSON lines as noise and would swallow the frame, hanging the request
 * until timeout).
 */
export function ringBell(): void {
  if (process.stdout.isTTY) process.stdout.write("\x07");
}

export default function (pi: ExtensionAPI) {
  pi.on("agent_settled", async () => {
    ringBell();
  });
}
