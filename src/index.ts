/**
 * luna meta-extension
 *
 * Dynamically loads sub-extensions from `parts/` based on `~/.pi/agent/extensions/luna.json`.
 *
 *   {
 *     "extensions": {
 *       "bell":   true,
 *       "effort": true,
 *       "exit":   false
 *     }
 *   }
 *
 * Unlisted sub-extensions default to enabled. Because loading is *dynamic*
 * (`await import()`), a disabled sub-extension is never imported at all — it
 * doesn't register tools/commands/events and doesn't appear in the load graph.
 *
 * The factory is async, so pi awaits it before continuing startup. Toggling
 * config requires a `/reload` (the config is read and imports resolved at load).
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface LunaConfig {
  extensions?: Record<string, boolean>;
}

/** Descriptor per dynamic sub-extension. Only these are ever imported. */
const PARTS_SPEC: Record<string, { description: string; file: string }> = {
  ask: {
    description: "Agent tool to ask the user structured questions",
    file: join(__dirname, "parts", "ask.ts"),
  },
  bell: {
    description: "Rings the terminal bell on agent settle",
    file: join(__dirname, "parts", "bell.ts"),
  },
  effort: {
    description: "Registers /effort thinking-level picker",
    file: join(__dirname, "parts", "effort.ts"),
  },
  exit: {
    description: "Registers /exit command",
    file: join(__dirname, "parts", "exit.ts"),
  },
  sandbox: {
    description: "Runs agent bash commands inside a landstrip sandbox",
    file: join(__dirname, "parts", "sandbox.ts"),
  },
  modes: {
    description: "Build/Plan mode switching (shift+tab)",
    file: join(__dirname, "parts", "modes.ts"),
  },
};

/** Toggle config lives in the user dir, not the repo. */
function resolveConfigPath(): string | undefined {
  const candidate = join(homedir(), ".pi", "agent", "extensions", "luna.json");
  return existsSync(candidate) ? candidate : undefined;
}

function loadConfig(): LunaConfig {
  const path = resolveConfigPath();
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LunaConfig;
  } catch (err) {
    console.error(`[luna] failed to parse ${path}:`, err);
    return {};
  }
}

export default async function (pi: ExtensionAPI) {
  const config = loadConfig();
  const overrides = config.extensions ?? {};
  const active: string[] = [];

  // Dynamically import each enabled sub-extension. Disabled ones are skipped
  // entirely — no import, no registration.
  for (const [key, spec] of Object.entries(PARTS_SPEC)) {
    const enabled = overrides[key] ?? true; // default on
    if (!enabled) {
      console.log(
        `[luna] "${key}" skipped (disabled in ~/.pi/agent/extensions/luna.json)`,
      );
      continue;
    }
    const mod = await import(spec.file);
    if (typeof mod.default === "function") {
      mod.default(pi);
      active.push(key);
    } else {
      console.error(`[luna] "${key}" has no default factory, skipping`);
    }
  }

  console.log(
    `[luna] dynamically loaded: ${active.length ? active.join(", ") : "(none)"}`,
  );

  // Management command. Registration is immediate; changing toggles needs /reload.
  pi.registerCommand("luna", {
    description:
      "Show which luna sub-extensions are loaded, then optionally reload",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      for (const [key, spec] of Object.entries(PARTS_SPEC)) {
        const enabled = overrides[key] ?? true;
        const state = active.includes(key) ? "loaded" : "skipped";
        ctx.ui.notify(
          `${enabled ? "●" : "○"} ${key} [${state}] — ${spec.description}`,
          "info",
        );
      }
      const action = await ctx.ui.select("luna", [
        "Reload (re-apply config)",
        "Cancel",
      ]);
      if (action === "Reload (re-apply config)") {
        await ctx.reload();
        return;
      }
    },
  });
}
