/**
 * /exit
 *
 * Gracefully exits pi, like every other CLI on the planet. Defers until the
 * agent is idle, so it won't murder a run mid-flight.
 *
 * Note: /quit already exists as a built-in interactive command (handled
 * before extension dispatch), so this only adds /exit. Extensions can't
 * register aliases for built-in commands — name collisions with built-ins
 * lose.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("exit", {
    description: "Exit pi",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      ctx.ui.notify("Goodbye!", "info");
      ctx.shutdown();
    },
  });
}
