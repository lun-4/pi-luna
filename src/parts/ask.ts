/**
 * ask part
 *
 * An agent tool for asking luna structured questions. Every question can
 * always be answered with free text — options are conveniences, not cages.
 * There is no timeout: the tool blocks until luna answers or hits Escape
 * (Escape → cancelled: true; the agent decides what that means).
 *
 * Execution is tiered by need:
 *   1. no UI            → throw (blocking forever headless would be a hang)
 *   2. 1 question, no options, single-select      → ui.input directly
 *   3. 1 question with options, single-select     → ui.select with a trailing
 *      "✎ type your own answer" item that falls through to ui.input
 *   4. multiple questions, or multi: true         → one ui.custom form where
 *      Enter submits all answers at once, Space toggles options, E edits the
 *      free-text line. In RPC mode (no custom()) falls back to a sequence of
 *      plain select/input dialogs.
 *
 * The UI is behind a small seam (AskUI) so behavior is unit-testable headless.
 *
 * Rings the terminal bell once before showing the first prompt. Unlike plan_submit,
 * which only seems to ring because its accepted turn ends (agent_settled → bell.ts),
 * ask blocks mid-turn, so no settle fires — it has to ring for itself.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Opaque identifier, echoed back in the result" }),
  text: Type.String({ description: "The question to ask" }),
  options: Type.Optional(
    Type.Array(Type.String(), {
      description: "Multiple-choice options when provided (A/B/C/...)",
    }),
  ),
  multi: Type.Optional(
    Type.Boolean({
      description: "Allow selecting multiple options (default: single-select)",
    }),
  ),
});

const schema = Type.Object({
  questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

export type AskQuestion = Static<typeof QuestionSchema>;
export type AskParams = Static<typeof schema>;

export interface AskAnswer {
  id: string;
  selected: string[];
  custom: string;
}

export interface AskResult {
  answers: AskAnswer[];
  cancelled: boolean;
}

// ---------------------------------------------------------------------------
// UI seam
// ---------------------------------------------------------------------------

export interface AskUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  /** Only present in TUI mode; RPC falls back to select/input sequences. */
  custom?<T>(
    factory: (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: (result: T) => void,
    ) => unknown,
  ): Promise<T>;
}

export interface AskToolDeps {
  ui: AskUI;
  hasUI(): boolean;
  /** Ring the terminal bell (\a) to get luna's attention before prompting. */
  bell(): void;
}

const CUSTOM_OPTION = "✎ type your own answer";

function result(answers: AskAnswer[], cancelled: boolean) {
  const payload: AskResult = { answers, cancelled };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function emptyAnswers(questions: AskQuestion[]): AskAnswer[] {
  return questions.map((q) => ({ id: q.id, selected: [], custom: "" }));
}

// ---------------------------------------------------------------------------
// Sequential dialogs (tiers 2/3, and tier-4 fallback for RPC)
// ---------------------------------------------------------------------------

async function askSequential(
  questions: AskQuestion[],
  ui: AskUI,
): Promise<{ answers: AskAnswer[]; cancelled: boolean }> {
  const answers: AskAnswer[] = [];
  for (const q of questions) {
    const answer: AskAnswer = { id: q.id, selected: [], custom: "" };
    if (q.options && q.options.length > 0) {
      const choices = [...q.options, CUSTOM_OPTION];
      if (q.multi) {
        // Multi-select has no native dialog; toggle one at a time with a Done item.
        const picked = new Set<string>();
        for (;;) {
          const rendered = choices.map((o) => (picked.has(o) ? `☑ ${o}` : `☐ ${o}`));
          const choice = await ui.select(`${q.text} (pick, then Done)`, [...rendered, "Done"]);
          if (choice === undefined) return { answers: emptyAnswers(questions), cancelled: true };
          if (choice === "Done") break;
          const bare = choice.slice(2);
          if (bare === CUSTOM_OPTION) {
            const custom = await ui.input(q.text, "");
            if (custom === undefined) return { answers: emptyAnswers(questions), cancelled: true };
            if (custom.trim()) answer.custom = custom.trim();
          } else if (picked.has(bare)) {
            picked.delete(bare);
          } else {
            picked.add(bare);
          }
        }
        answer.selected = q.options.filter((o) => picked.has(o));
      } else {
        const choice = await ui.select(q.text, choices);
        if (choice === undefined) return { answers: emptyAnswers(questions), cancelled: true };
        if (choice === CUSTOM_OPTION) {
          const custom = await ui.input(q.text, "");
          if (custom === undefined) return { answers: emptyAnswers(questions), cancelled: true };
          answer.custom = custom.trim();
        } else {
          answer.selected = [choice];
        }
      }
    } else {
      const custom = await ui.input(q.text, "");
      if (custom === undefined) return { answers: emptyAnswers(questions), cancelled: true };
      answer.custom = custom.trim();
    }
    answers.push(answer);
  }
  return { answers, cancelled: false };
}

// ---------------------------------------------------------------------------
// Tier 4: one combined form (TUI only)
// ---------------------------------------------------------------------------

interface FormState {
  focus: number; // question index, or questions.length for the submit row
  optionCursor: number[];
  picked: Set<number>[];
  editing: number; // question index being free-text edited, or -1
  inputs: string[];
}

function formSummary(state: FormState, questions: AskQuestion[]): AskAnswer[] {
  return questions.map((q, i) => ({
    id: q.id,
    selected: q.options ? q.options.filter((_, o) => state.picked[i].has(o)) : [],
    custom: state.inputs[i].trim(),
  }));
}

async function askForm(
  questions: AskQuestion[],
  ui: AskUI,
): Promise<{ answers: AskAnswer[]; cancelled: boolean }> {
  if (!ui.custom) return askSequential(questions, ui);

  type Done = (r: { answers: AskAnswer[]; cancelled: boolean }) => void;

  const out = await ui.custom<{ answers: AskAnswer[]; cancelled: boolean }>(
    (tui, theme, _kb, done: Done) => {
      const th = theme as {
        fg(color: string, s: string): string;
        bold(s: string): string;
        bg(color: string, s: string): string;
      };
      const state: FormState = {
        focus: 0,
        optionCursor: questions.map(() => 0),
        picked: questions.map(() => new Set<number>()),
        editing: -1,
        inputs: questions.map(() => ""),
      };
      const editor = new Input();
      let cached: string[] | undefined;
      const requestRender = (tui as { requestRender(): void }).requestRender.bind(tui);

      const refresh = () => {
        cached = undefined;
        requestRender();
      };

      editor.onSubmit = (value: string) => {
        state.inputs[state.editing] = value;
        state.editing = -1;
        editor.setValue("");
        refresh();
      };
      editor.onEscape = () => {
        state.editing = -1;
        editor.setValue("");
        refresh();
      };

      const submit = (cancelled: boolean) => {
        done({ answers: formSummary(state, questions), cancelled });
      };

      const maxRow = questions.length; // submit row index

      function handleInput(data: string) {
        if (state.editing >= 0) {
          editor.handleInput(data);
          refresh();
          return;
        }
        if (matchesKey(data, Key.escape)) return submit(true);
        if (matchesKey(data, Key.up)) {
          state.focus = Math.max(0, state.focus - 1);
          return refresh();
        }
        if (matchesKey(data, Key.down)) {
          state.focus = Math.min(maxRow, state.focus + 1);
          return refresh();
        }
        if (state.focus === maxRow) {
          if (matchesKey(data, Key.enter)) return submit(false);
          return;
        }
        const q = questions[state.focus]!;
        const i = state.focus;
        if (matchesKey(data, Key.enter)) return submit(false);
        if (matchesKey(data, "e") || data === "E") {
          state.editing = i;
          editor.setValue(state.inputs[i]);
          return refresh();
        }
        if (q.options && q.options.length > 0) {
          if (matchesKey(data, Key.left)) {
            state.optionCursor[i] = Math.max(0, state.optionCursor[i] - 1);
            return refresh();
          }
          if (matchesKey(data, Key.right)) {
            state.optionCursor[i] = Math.min(q.options.length - 1, state.optionCursor[i] + 1);
            return refresh();
          }
          if (matchesKey(data, Key.space)) {
            const c = state.optionCursor[i];
            if (q.multi) {
              if (state.picked[i].has(c)) state.picked[i].delete(c);
              else state.picked[i].add(c);
            } else {
              state.picked[i] = new Set([c]);
            }
            return refresh();
          }
        }
      }

      function render(width: number): string[] {
        if (cached) return cached;
        const w = Math.max(1, width);
        const lines: string[] = [];
        const wrap = (prefix: string, text: string) => {
          const pw = visibleWidth(prefix);
          if (pw >= w) {
            lines.push(...wrapTextWithAnsi(prefix + text, w));
            return;
          }
          const wrapped = wrapTextWithAnsi(text, w - pw);
          wrapped.forEach((line, idx) => {
            lines.push((idx === 0 ? prefix : " ".repeat(pw)) + line);
          });
        };

        lines.push(th.fg("accent", "─".repeat(w)));
        questions.forEach((q, i) => {
          const focused = state.focus === i;
          const marker = focused ? th.fg("accent", "❯ ") : "  ";
          wrap(marker, th.fg(focused ? "text" : "muted", th.bold(q.text)));
          if (q.options && q.options.length > 0) {
            const chips = q.options
              .map((opt, o) => {
                const box = state.picked[i].has(o) ? "☑" : "☐";
                const label = ` ${box} ${opt} `;
                if (focused && state.optionCursor[i] === o) return th.bg("selectedBg", th.fg("text", label));
                return th.fg(state.picked[i].has(o) ? "success" : "dim", label);
              })
              .join("");
            wrap("    ", chips);
          }
          const custom = state.inputs[i];
          if (state.editing === i) {
            wrap("    ", th.fg("muted", "answer: "));
            for (const line of editor.render(Math.max(1, w - 6))) lines.push(`      ${line}`);
          } else {
            wrap(
              "    ",
              custom
                ? th.fg("text", `✎ ${custom}`)
                : th.fg("dim", q.options ? "e: type your own answer" : "e: type your answer"),
            );
          }
          lines.push("");
        });
        const onSubmit = state.focus === maxRow;
        wrap(
          "  ",
          onSubmit
            ? th.bg("selectedBg", th.fg("text", " ✓ submit "))
            : th.fg("dim", " ✓ submit "),
        );
        lines.push("");
        wrap(
          "  ",
          th.fg(
            "dim",
            "↑↓ questions • ←→ options • space toggle • e edit answer • enter submit all • esc cancel",
          ),
        );
        lines.push(th.fg("accent", "─".repeat(w)));
        cached = lines;
        return lines;
      }

      return {
        render,
        handleInput,
        invalidate: () => {
          cached = undefined;
        },
      };
    },
  );

  return out;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function makeAskTool(deps: AskToolDeps) {
  return {
    name: "ask",
    label: "ask",
    description:
      "Ask luna one or more structured questions. Use when a decision forks the work: " +
      "requirements, preferences, or trade-offs only she can pick. Every question also " +
      "accepts a free-text answer, so options are conveniences, not constraints. Blocks " +
      "until answered or cancelled (Escape).",
    promptSnippet: "Ask the user structured questions when a decision forks the work",
    promptGuidelines: [
      "Use ask when a requirement, preference, or trade-off is ambiguous and the answer changes what gets built. Don't ask about things you can decide yourself.",
    ],
    parameters: schema,
    async execute(
      _toolCallId: string,
      params: AskParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown,
    ) {
      if (!deps.hasUI()) {
        throw new Error("ask: no UI available to prompt the user (headless mode)");
      }
      if (!params.questions.length) {
        return result([], false);
      }
      // The dialogs below block until luna answers; get her attention first.
      // One bell per ask call, not per question — the form and sequential flows
      // are a single questioning event.
      deps.bell();
      const needsForm = params.questions.length > 1 || params.questions.some((q) => q.multi);
      const r = needsForm
        ? await askForm(params.questions, deps.ui)
        : await askSequential(params.questions, deps.ui);
      return result(r.answers, r.cancelled);
    },
  };
}

// ---------------------------------------------------------------------------
// Part registration
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let ctxRef: { hasUI: boolean; mode: string; ui: AskUI } | undefined;

  pi.on("session_start", async (_e, ctx) => {
    ctxRef = {
      get hasUI() {
        return ctx.hasUI;
      },
      get mode() {
        return ctx.mode;
      },
      ui: {
        select: (t, o) => ctx.ui.select(t, o),
        input: (t, p) => ctx.ui.input(t, p),
        ...(ctx.mode === "tui"
          ? { custom: (f: never) => ctx.ui.custom(f as never) }
          : {}),
      },
    };
  });

  const tool = makeAskTool({
    hasUI: () => ctxRef?.hasUI ?? false,
    bell: () => process.stdout.write("\x07"),
    ui: {
      select: (t, o) => ctxRef!.ui.select(t, o),
      input: (t, p) => ctxRef!.ui.input(t, p),
      custom: (f) => {
        if (!ctxRef?.ui.custom) throw new Error("ask: custom form requires TUI mode");
        return ctxRef.ui.custom(f);
      },
    },
  });
  // In RPC mode custom is absent on the seam; askForm falls back to dialogs.
  pi.registerTool(tool as never);
}
