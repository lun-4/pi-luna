/**
 * ask tool behavior through a fake AskUI seam. Runs anywhere (no TUI).
 */
import { describe, it, expect } from "vitest";
import { makeAskTool, type AskUI, type AskQuestion } from "../src/parts/ask.js";

function fakeUi(overrides: Partial<AskUI> = {}): AskUI & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async select(title, options) {
      calls.push(`select:${title}:${options.join("|")}`);
      return overrides.select ? overrides.select(title, options) : undefined;
    },
    async input(title, placeholder) {
      calls.push(`input:${title}`);
      return overrides.input ? overrides.input(title, placeholder) : undefined;
    },
    ...(overrides.custom
      ? {
          custom: async <T>(_factory: unknown): Promise<T> => {
            calls.push("custom");
            return overrides.custom!(_factory as never) as Promise<T>;
          },
        }
      : {}),
  } as AskUI & { calls: string[] };
}

function toolWith(ui: AskUI & { calls: string[] }, hasUI = true) {
  const tool = makeAskTool({
    ui,
    hasUI: () => hasUI,
    bell: () => ui.calls.push("bell"),
  });
  const run = (questions: AskQuestion[]) =>
    tool.execute("id", { questions }, undefined, undefined, undefined);
  return { tool, run };
}

describe("ask tool", () => {
  it("throws with no UI (headless)", async () => {
    const ui = fakeUi();
    const { run } = toolWith(ui, false);
    await expect(run([{ id: "q1", text: "?" }])).rejects.toThrow(/no UI/);
    expect(ui.calls).toEqual([]); // no prompt, no bell
  });

  it("empty questions → empty result, not cancelled (and no bell)", async () => {
    const ui = fakeUi();
    const { run } = toolWith(ui);
    const r = await run([]);
    expect(JSON.parse(r.content[0].text)).toEqual({ answers: [], cancelled: false });
    expect(ui.calls).toEqual([]);
  });

  it("tier 2: one question without options → input (bell first)", async () => {
    const ui = fakeUi({ input: async () => "because reasons" });
    const { run } = toolWith(ui);
    const r = await run([{ id: "why", text: "Why?" }]);
    expect(ui.calls).toEqual(["bell", "input:Why?"]);
    expect(JSON.parse(r.content[0].text)).toEqual({
      answers: [{ id: "why", selected: [], custom: "because reasons" }],
      cancelled: false,
    });
  });

  it("tier 3: one question with options → select with custom-answer escape hatch", async () => {
    const ui = fakeUi({ select: async (_t, o) => o[1] });
    const { run } = toolWith(ui);
    const r = await run([{ id: "pick", text: "Pick one", options: ["A", "B", "C"] }]);
    expect(ui.calls).toEqual(["bell", "select:Pick one:A|B|C|✎ type your own answer"]);
    expect(JSON.parse(r.content[0].text)).toEqual({
      answers: [{ id: "pick", selected: ["B"], custom: "" }],
      cancelled: false,
    });
  });

  it("tier 3: choosing the ✎ option falls through to input", async () => {
    const ui = fakeUi({
      select: async (_t, o) => o[o.length - 1], // ✎ type your own answer
      input: async () => "something else entirely",
    });
    const { run } = toolWith(ui);
    const r = await run([{ id: "pick", text: "Pick one", options: ["A", "B"] }]);
    expect(ui.calls).toEqual(["bell", "select:Pick one:A|B|✎ type your own answer", "input:Pick one"]);
    expect(JSON.parse(r.content[0].text)).toEqual({
      answers: [{ id: "pick", selected: [], custom: "something else entirely" }],
      cancelled: false,
    });
  });

  it("escape on select → cancelled", async () => {
    const ui = fakeUi({ select: async () => undefined });
    const { run } = toolWith(ui);
    const r = await run([{ id: "pick", text: "Pick one", options: ["A"] }]);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.cancelled).toBe(true);
    expect(parsed.answers).toEqual([{ id: "pick", selected: [], custom: "" }]);
  });

  it("escape on input → cancelled", async () => {
    const ui = fakeUi({ input: async () => undefined });
    const { run } = toolWith(ui);
    const r = await run([{ id: "why", text: "Why?" }]);
    expect(JSON.parse(r.content[0].text).cancelled).toBe(true);
  });

  it("tier 4: multiple questions use the custom form when available", async () => {
    const answers = {
      answers: [
        { id: "a", selected: ["X"], custom: "" },
        { id: "b", selected: [], custom: "typed" },
      ],
      cancelled: false,
    };
    const ui = fakeUi({ custom: (async () => answers) as AskUI["custom"] });
    const { run } = toolWith(ui);
    const r = await run([
      { id: "a", text: "A?", options: ["X", "Y"] },
      { id: "b", text: "B?" },
    ]);
    expect(ui.calls).toEqual(["bell", "custom"]);
    expect(JSON.parse(r.content[0].text)).toEqual(answers);
  });

  it("tier 4: multi:true on a single question also uses the custom form", async () => {
    const answers = {
      answers: [{ id: "m", selected: ["A", "C"], custom: "" }],
      cancelled: false,
    };
    const ui = fakeUi({ custom: (async () => answers) as AskUI["custom"] });
    const { run } = toolWith(ui);
    const r = await run([{ id: "m", text: "Multi?", options: ["A", "B", "C"], multi: true }]);
    expect(ui.calls).toEqual(["bell", "custom"]);
    expect(JSON.parse(r.content[0].text)).toEqual(answers);
  });

  it("tier 4 falls back to sequential dialogs without a custom seam (RPC)", async () => {
    // No custom on the seam → select/input sequence per question.
    const ui = fakeUi({
      select: async (_t, o) => o[0],
      input: async () => "typed answer",
    });
    const { run } = toolWith(ui);
    const r = await run([
      { id: "a", text: "A?", options: ["X", "Y"] },
      { id: "b", text: "B?" },
    ]);
    expect(ui.calls).toEqual(["bell", "select:A?:X|Y|✎ type your own answer", "input:B?"]);
    expect(JSON.parse(r.content[0].text)).toEqual({
      answers: [
        { id: "a", selected: ["X"], custom: "" },
        { id: "b", selected: [], custom: "typed answer" },
      ],
      cancelled: false,
    });
  });

  it("rpc multi-select toggles until Done", async () => {
    const picks = ["☐ A", "☐ B", "Done"]; // toggle A, toggle B, done
    let i = 0;
    const ui = fakeUi({ select: async () => picks[i++] });
    const { run } = toolWith(ui);
    const r = await run([{ id: "m", text: "Multi?", options: ["A", "B"], multi: true }]);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.cancelled).toBe(false);
    expect(parsed.answers[0].selected).toEqual(["A", "B"]);
  });

  it("result is parseable JSON with the question ids echoed", async () => {
    const ui = fakeUi({ input: async () => "ok" });
    const { run } = toolWith(ui);
    const r = await run([{ id: "opaque-123", text: "Say ok" }]);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.answers[0].id).toBe("opaque-123");
    expect(r.details.answers).toEqual(parsed.answers);
  });
});
