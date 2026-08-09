/**
 * modes part — Build/Plan mode switching
 *
 * Shift+Tab (or /plan, /build) toggles between Build mode (default, full
 * toolset) and Plan mode (read-only + plan file). Shown in the footer as
 * "mode: build" / "mode: plan".
 *
 * Plan mode:
 *   - active tools: read, grep, find, ls, ask, plan_submit, write, edit
 *   - write/edit are gated to the single plan file
 *     (<cwd>/.pi/plans/<sessionId>.md) by one pure tool_call guard
 *   - plan directives are appended to the system prompt on every turn that
 *     starts in plan mode
 *
 * The plan is a real file owned here; the agent develops it with normal
 * write/edit, and plan_submit takes a handle to it. Submission prints the
 * full plan, then asks: accept → /plan-accept is staged in the editor and
 * submitted for her (one injected Enter), opening a new session with the
 * plan as first message, already running; talk → freeform feedback steered
 * back to the agent for revision.
 *
 * Enforcement is a single pure function (planModeGate) — the built-in
 * write/edit stay untouched, and Build mode passes everything through except
 * plan_submit (double-fenced: stripped from the build toolset by toolListFor,
 * and blocked by name here).
 *
 * Entering/leaving plan mode never aborts an in-flight turn: the round-trip
 * already sent its toolset, so the plan toolset applies from the next LLM
 * call. Mode state is in-memory per session (resets on session_start); plan
 * files persist on disk.
 */

import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Type, type Static } from "typebox";

// ---------------------------------------------------------------------------
// Types & state
// ---------------------------------------------------------------------------

export type Mode = "build" | "plan";

export interface ModesState {
  mode: Mode;
  /** Active toolset captured at session_start (respects --tools/--exclude-tools). */
  buildTools: string[];
  /** Plan path after accept, before the /plan-accept handoff runs. */
  handoffPending: string | undefined;
  /** <cwd>/.pi/plans/<sessionId>.md */
  planPath: string | undefined;
}

export const PLAN_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "ask",
  "plan_submit",
  "write",
  "edit",
] as const;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested directly)
// ---------------------------------------------------------------------------

/** Resolve a possibly-relative/~ path against cwd. Strips a leading @ like builtins do. */
export function resolveTarget(cwd: string, p: string): string {
  let s = p.trim();
  if (s.startsWith("@")) s = s.slice(1);
  if (s === "~") s = homedir();
  else if (s.startsWith("~/") || s.startsWith("~\\")) s = path.join(homedir(), s.slice(2));
  return path.resolve(cwd, s);
}

/** Canonical comparison target for plan-writability (path.resolve, no symlink chasing). */
export function allowPlanWrite(
  targetPath: string | undefined,
  planPath: string | undefined,
  cwd: string,
): boolean {
  if (!targetPath || !planPath) return false;
  return resolveTarget(cwd, targetPath) === path.resolve(planPath);
}

/** The toolset for a mode. Plan intersects the strict set with what's registered. */
export function toolListFor(mode: Mode, buildTools: string[]): string[] {
  if (mode === "build") {
    // plan_submit is plan-only. pi auto-activates ALL registered extension
    // tools at session_start (includeAllExtensionTools), so it leaks into
    // buildTools and thus into build mode unless we strip it — and its
    // description ("only usable in plan mode") visibly confuses the model
    // in an executing session. ask stays: it's active in both modes.
    return buildTools.filter((t) => t !== "plan_submit");
  }
  const plan: string[] = PLAN_TOOLS.filter((t) => buildTools.includes(t));
  for (const extra of ["ask", "plan_submit"]) {
    if (!plan.includes(extra)) plan.push(extra);
  }
  return plan;
}

export interface GateDecision {
  block: boolean;
  reason?: string;
}

/**
 * The one enforcement point. Pure: decide whether a tool call may proceed.
 */
export function planModeGate(
  state: Pick<ModesState, "mode" | "planPath" | "handoffPending">,
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): GateDecision {
  if (state.handoffPending) {
    return { block: true, reason: "Plan accepted — new session starting" };
  }
  if (state.mode === "build") {
    if (toolName === "plan_submit") {
      return { block: true, reason: "plan_submit is only available in plan mode" };
    }
    return { block: false };
  }
  // plan mode
  if (toolName === "write" || toolName === "edit") {
    const p = typeof input?.path === "string" ? input.path : undefined;
    if (allowPlanWrite(p, state.planPath, cwd)) return { block: false };
    return {
      block: true,
      reason: `Plan mode: only the plan file is writable (${state.planPath ?? "unknown"})`,
    };
  }
  if (toolName === "plan_submit") {
    const f = typeof input?.file === "string" ? input.file : undefined;
    if (allowPlanWrite(f, state.planPath, cwd)) return { block: false };
    return { block: true, reason: "plan_submit: file must be the session plan file" };
  }
  if (!(PLAN_TOOLS as readonly string[]).includes(toolName)) {
    return { block: true, reason: `Not available in plan mode: ${toolName}` };
  }
  return { block: false };
}

// ---------------------------------------------------------------------------
// plan_submit UI seam (unit-testable headless)
// ---------------------------------------------------------------------------

export interface ModeUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
}

export type SubmitOutcome =
  | { kind: "missing" }
  | { kind: "cancelled"; content: string }
  | { kind: "accept"; content: string; planPath: string }
  | { kind: "talk"; content: string; feedback: string };

const ACCEPT = "Accept & start building";
const TALK = "Talk about the plan";

/** Map a review decision + feedback text to a SubmitOutcome. Pure. */
export function decideReview(
  content: string,
  planPath: string,
  decision: "accept" | "talk" | "cancelled",
  feedback?: string,
): SubmitOutcome {
  if (decision === "accept") return { kind: "accept", content, planPath };
  const fb = feedback?.trim();
  if (decision === "talk" && fb) return { kind: "talk", content, feedback: fb };
  return { kind: "cancelled", content };
}

/**
 * Plan review decision, isolated from tool plumbing. The full plan is printed
 * to the transcript before this runs (printPlan), so the dialog stays small —
 * pick Accept/Talk, feedback via a plain input. Wheel-scrolls like any other
 * transcript output.
 *
 * Rings the terminal bell (bell()) right before the decision dialog blocks,
 * so luna hears it when the agent submits — the dialog blocks mid-turn, so
 * agent_settled never fires while it's up.
 */
export async function runSubmitFlow(opts: {
  ui: ModeUI;
  planPath: string;
  readPlan: (p: string) => Promise<string | undefined>;
  /** Ring the terminal bell (\a) to get luna's attention before the dialog. */
  bell(): void;
}): Promise<SubmitOutcome> {
  const content = await opts.readPlan(opts.planPath);
  if (!content || !content.trim()) return { kind: "missing" };
  opts.bell();
  const choice = await opts.ui.select("Plan submitted", [ACCEPT, TALK]);
  return decideReview(
    content,
    opts.planPath,
    choice === ACCEPT ? "accept" : choice === TALK ? "talk" : "cancelled",
    choice === TALK ? await opts.ui.input("Feedback:", "") : undefined,
  );
}

/** First message of the accepted plan's executing session: the plan, then go. */
export function buildAcceptKickoff(content: string): string {
  return `${content}\n\ncan you build this?`;
}

// ---------------------------------------------------------------------------
// Part registration
// ---------------------------------------------------------------------------

const planSubmitSchema = Type.Object({
  file: Type.String({ description: "Path to the plan file (the session plan file)" }),
  message: Type.Optional(Type.String({ description: "Optional short note about the plan" })),
});
export type PlanSubmitParams = Static<typeof planSubmitSchema>;

export default function (pi: ExtensionAPI) {
  const state: ModesState = {
    mode: "build",
    buildTools: [],
    handoffPending: undefined,
    planPath: undefined,
  };

  function updateStatus(ctx: ExtensionContext | undefined) {
    if (!ctx?.hasUI) return;
    ctx.ui.setStatus("mode", `mode: ${state.mode}`);
  }

  function applyMode(ctx: ExtensionContext) {
    pi.setActiveTools(toolListFor(state.mode, state.buildTools));
    updateStatus(ctx);
  }

  function setMode(next: Mode, ctx: ExtensionContext) {
    if (state.mode === next) return;
    state.mode = next;
    applyMode(ctx);
    ctx.ui.notify(
      next === "plan"
        ? "Plan mode — read tools + plan file only. Shift+Tab or /build to exit."
        : "Build mode — full toolset restored.",
      "info",
    );
  }

  pi.on("session_start", async (_e, ctx) => {
    state.mode = "build";
    state.handoffPending = undefined;
    state.buildTools = pi.getActiveTools();
    const sessionId = ctx.sessionManager.getSessionId();
    state.planPath = path.join(ctx.cwd, CONFIG_DIR_NAME, "plans", `${sessionId}.md`);
    mkdirSync(path.dirname(state.planPath), { recursive: true });
    applyMode(ctx);
  });

  pi.on("session_shutdown", async (_e, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("mode", undefined);
  });

  // -- accept handoff ------------------------------------------------------------

  /**
   * The equivalent of /new + paste plan + Enter, all at once. Runs inside the
   * /plan-accept command handler — commands are the only surface pi hands a
   * live ExtensionCommandContext (ctx.newSession) to, so the handoff must
   * arrive as a command: typed by luna as the manual fallback, or staged and
   * auto-submitted by the agent_settled hook below. pi dispatches both
   * identically, on a command ctx it mints fresh at execution time.
   *
   * Follows pi's documented session-replacement pattern: capture plain data
   * before newSession (the ctx goes stale the moment teardown runs — pi
   * invalidates the whole runner), then use ONLY the fresh ctx handed to
   * withSession. sendUserMessage always triggers a turn, so the plan lands
   * as the first message of the fresh session and immediately starts
   * executing; the fresh session starts in build mode by design
   * (session_start resets it).
   */
  async function runPlanAccept(planPath: string, ctx: ExtensionCommandContext) {
    let content: string;
    try {
      content = await readFile(planPath, "utf8");
    } catch {
      ctx.ui.notify(`plan accept: cannot read plan file: ${planPath}`, "error");
      return;
    }
    if (!content.trim()) {
      ctx.ui.notify(`plan accept: plan file is empty: ${planPath}`, "error");
      return;
    }
    const parentSession = ctx.sessionManager.getSessionFile();
    const kickoff = buildAcceptKickoff(content);
    await ctx.newSession({
      parentSession,
      withSession: async (newCtx) => {
        await newCtx.sendUserMessage(kickoff);
      },
    });
  }

  /**
   * After an accepted plan_submit, fire the handoff. There is no API to
   * dispatch a command programmatically, and the two obvious hacks both lose:
   * queued steer/followUp text bypasses command dispatch entirely (it reaches
   * the model as plain text — the original bug), and a captured command ctx
   * goes stale at session replacement (the "context not found" failure luna
   * hit). So don't dispatch — TYPE: stage /plan-accept in the editor and
   * inject a single Enter into stdin. The TUI consumes it exactly like a
   * physical keypress (pi-tui reads stdin in flowing mode; pasteToEditor does
   * the same handleInput injection from pi's own UI layer), running the
   * command on a guaranteed-live ctx. If there's no TUI or she has an editor
   * draft, degrade to telling her what to run.
   */
  pi.on("agent_settled", async (_e, ctx) => {
    const planPath = state.handoffPending;
    state.handoffPending = undefined;
    if (!planPath) return;
    const cmd = `/plan-accept ${planPath}`;
    const canInject =
      ctx.hasUI && ctx.mode === "tui" && !(ctx.ui.getEditorText()?.trim());
    if (!canInject) {
      ctx.ui.notify(`Plan accepted — start it with: ${cmd}`, "info");
      return;
    }
    ctx.ui.setEditorText(cmd);
    // Defer past the settle finally-block (idle resolution) and the turn's
    // final render, then press Enter. Re-check that the staged command is
    // still what's in the editor before submitting — if luna started typing
    // into the staged command in the meantime, don't clobber her input with
    // a submit of mixed text (covers the pathological race; the window is a
    // few milliseconds). The command it submits replaces this session; if
    // stdin isn't injectable nothing is lost — the staged command stays in
    // the editor, one physical Enter away.
    setTimeout(() => {
      if (ctx.ui.getEditorText() !== cmd) return;
      try {
        process.stdin.push("\r");
      } catch {
        // The staged command is still in the editor; nothing more to do.
      }
    }, 0);
  });

  // Printed plans render in the transcript (TUI-only entries; never sent to
  // the LLM — the agent already has the plan content in its tool result).
  pi.registerEntryRenderer(
    "plan-print",
    (entry, _options, theme): Component => {
      const data = entry.data as { path?: string; content?: string } | undefined;
      const text =
        theme.fg("accent", theme.bold(`Plan — ${data?.path ?? "?"}`)) +
        "\n\n" +
        (data?.content ?? "");
      return new Text(text, 1, 0);
    },
  );

  /** Print the full plan into the transcript so luna can wheel-scroll it. */
  function printPlan(planPath: string, content: string) {
    pi.appendEntry("plan-print", { path: planPath, content });
  }

  // -- enforcement -----------------------------------------------------------

  pi.on("tool_call", async (event, ctx) => {
    const decision = planModeGate(
      state,
      event.toolName,
      event.input as { path?: unknown; file?: unknown },
      ctx.cwd,
    );
    if (decision.block) return { block: true, reason: decision.reason };
  });

  // -- plan directives --------------------------------------------------------

  pi.on("before_agent_start", async (event) => {
    if (state.mode !== "plan" || !state.planPath) return;
    const directive = [
      "",
      `You are in **Plan mode**. The plan file is \`${state.planPath}\`.`,
      "Develop the plan there using `write` and `edit` — no other file is writable, and there is no shell.",
      "Use `read` and the search tools freely, and `ask` when a decision forks the plan.",
      "A plan states the goal, ordered steps, files touched, risks, and open questions.",
      "When it's complete, submit it with `plan_submit` (passing the file path); you may revise and resubmit until the user accepts.",
    ].join("\n");
    return { systemPrompt: event.systemPrompt + "\n" + directive };
  });

  // -- plan_submit -------------------------------------------------------------

  pi.registerTool({
    name: "plan_submit",
    label: "plan_submit",
    description:
      "Submit the plan file for review. Prints the full plan, then asks luna to accept " +
      "(a new session starts executing it) or talk about it (feedback is sent back to you " +
      "for revision). Only usable in plan mode; the file must be the session plan file.",
    promptSnippet: "Submit the finished plan file for user review",
    parameters: planSubmitSchema,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) throw new Error("plan_submit: no UI available to prompt the user");
      if (state.handoffPending) {
        return {
          content: [{ type: "text", text: "Plan accepted — a new session is starting." }],
          details: { accepted: true },
        };
      }
      let outcome;
      {
        // Print the full plan into the transcript first, so it's wheel-scrollable
        // while the decision dialog is up (and survives resume). Skip when the
        // plan is missing/empty — the "write it first" error says enough.
        let content: string | undefined;
        try {
          content = await readFile(state.planPath ?? "", "utf8");
        } catch {
          content = undefined;
        }
        if (content?.trim() && ctx.hasUI) printPlan(state.planPath ?? "", content);
        outcome = await runSubmitFlow({
          ui: ctx.ui,
          planPath: state.planPath ?? "",
          readPlan: async () => content,
          bell: () => process.stdout.write("\x07"),
        });
      }
      if (outcome.kind === "missing") {
        return {
          content: [
            { type: "text", text: `No plan at ${state.planPath} yet — write it first.` },
          ],
          details: { submitted: false },
        };
      }
      const printed = `Plan (${state.planPath}):\n\n${outcome.content}`;
      if (outcome.kind === "cancelled") {
        return {
          content: [{ type: "text", text: `${printed}\n\nPlan submission cancelled — still in plan mode.` }],
          details: { submitted: false, cancelled: true },
        };
      }
      if (outcome.kind === "talk") {
        pi.sendUserMessage(outcome.feedback, { deliverAs: "steer" });
        return {
          content: [
            { type: "text", text: `${printed}\n\nFeedback sent — revise the plan and resubmit.` },
          ],
          details: { submitted: false, feedback: outcome.feedback },
        };
      }
      // accept — hand off on agent_settled (see the hook above); terminate so
      // the turn ends cleanly instead of making another LLM call first.
      state.handoffPending = outcome.planPath;
      pi.appendEntry("plan-submission", {
        path: outcome.planPath,
        ts: Date.now(),
        accepted: true,
        message: params.message,
      });
      return {
        content: [
          { type: "text", text: `${printed}\n\nPlan accepted — a new session will start executing it.` },
        ],
        details: { submitted: true, accepted: true, path: outcome.planPath },
        terminate: true,
      };
    },
  });

  // -- commands ----------------------------------------------------------------

  // The whole accept flow converges here: auto-submitted by the agent_settled
  // hook, or typed by hand. Either way pi mints the command ctx fresh.
  pi.registerCommand("plan-accept", {
    description: "Start a new session executing an accepted plan file",
    handler: async (args, ctx) => {
      const planPath = state.handoffPending ?? args.trim();
      state.handoffPending = undefined;
      if (!planPath) {
        ctx.ui.notify("plan-accept: no accepted plan pending; pass a plan file path", "error");
        return;
      }
      await runPlanAccept(planPath, ctx);
    },
  });

  pi.registerCommand("plan", {
    description: "Enter plan mode (read-only + plan file). /plan <message> kicks off planning.",
    handler: async (args, ctx) => {
      setMode("plan", ctx);
      const msg = args.trim();
      if (msg) pi.sendUserMessage(msg);
    },
  });

  pi.registerCommand("build", {
    description: "Return to build mode (full toolset)",
    handler: async (_args, ctx) => {
      setMode("build", ctx);
    },
  });

  // -- shortcut ------------------------------------------------------------------

  pi.registerShortcut("shift+tab", {
    description: "Toggle build/plan mode",
    handler: async (ctx) => {
      setMode(state.mode === "build" ? "plan" : "build", ctx);
    },
  });

}
