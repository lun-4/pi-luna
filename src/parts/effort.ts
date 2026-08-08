/**
 * /effort + alt+tab thinking cycler
 *
 * `/effort` opens a picker for the model's thinking/effort level, like
 * Claude Code's /effort. `/effort <level>` sets it directly, and Tab
 * autocompletes level names. Only levels the current model actually
 * supports (per its thinkingLevelMap) are offered.
 *
 * Quick thinking-level cycling is handled by the built-in `app.thinking.cycle`
 * action, remapped from `shift+tab` to `alt+tab` in `~/.pi/agent/keybindings.json`.
 * This frees up `shift+tab` for future remapping. `/effort` remains the picker.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Canonical scale, cheapest to most expensive. xhigh/max only exist on
// models whose thinkingLevelMap explicitly maps them.
const ALL_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
type ThinkingLevel = (typeof ALL_LEVELS)[number];

interface ModelLike {
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

/** Levels the model supports, mirroring pi-ai's getSupportedThinkingLevels. */
function supportedLevels(model: ModelLike | undefined): ThinkingLevel[] {
  if (!model?.reasoning) return [];
  return ALL_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/** Snap a requested level to the nearest supported one, mirroring clampThinkingLevel. */
function clampLevel(
  model: ModelLike | undefined,
  level: ThinkingLevel,
): ThinkingLevel {
  const available = supportedLevels(model);
  if (available.length === 0) return "off";
  if (available.includes(level)) return level;
  const requestedIndex = ALL_LEVELS.indexOf(level);
  for (let i = requestedIndex; i < ALL_LEVELS.length; i++) {
    if (available.includes(ALL_LEVELS[i])) return ALL_LEVELS[i];
  }
  for (let i = requestedIndex - 1; i >= 0; i--) {
    if (available.includes(ALL_LEVELS[i])) return ALL_LEVELS[i];
  }
  return available[0];
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("effort", {
    description: "Set model thinking/effort level",
    getArgumentCompletions: (prefix) => {
      const items = ALL_LEVELS.map((level) => ({ value: level, label: level }));
      const filtered = items.filter((item) => item.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const levels = supportedLevels(ctx.model);
      if (levels.length === 0) {
        ctx.ui.notify(
          "Current model does not support thinking levels",
          "warning",
        );
        return;
      }

      const requested = args.trim().toLowerCase();
      if (requested.length > 0) {
        if ((ALL_LEVELS as readonly string[]).includes(requested)) {
          const level = clampLevel(ctx.model, requested as ThinkingLevel);
          pi.setThinkingLevel(level);
          ctx.ui.notify(
            level === requested
              ? `Thinking: ${level}`
              : `Thinking: ${level} (clamped from ${requested})`,
            "info",
          );
        } else {
          ctx.ui.notify(
            `Unknown effort level "${requested}". Valid: ${ALL_LEVELS.join(", ")}`,
            "error",
          );
        }
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify(
          `Thinking: ${pi.getThinkingLevel()} (pass a level to change it)`,
          "info",
        );
        return;
      }

      const current = pi.getThinkingLevel();
      const items = levels.map((level) =>
        level === current ? `${level} (current)` : level,
      );
      const selected = await ctx.ui.select("Thinking effort", items);
      if (!selected) return;
      const level = selected.replace(" (current)", "") as ThinkingLevel;
      pi.setThinkingLevel(level);
      ctx.ui.notify(`Thinking: ${level}`, "info");
    },
  });
}
