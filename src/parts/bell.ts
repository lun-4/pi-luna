/**
 * Bell Extension
 *
 * Rings the terminal bell (\a) when the pi agent settles and waits for input,
 * so luna knows her attention is needed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function bell(): void {
  process.stdout.write("\x07");
}

export default function (pi: ExtensionAPI) {
  pi.on("agent_settled", async () => {
    bell();
  });
}
