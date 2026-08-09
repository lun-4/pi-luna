/**
 * agents overlay — /agents split-pane view over live subagents
 *
 * Overview: subagent list (≈40% width) | condensed thread of the selection.
 * Enter focuses one subagent: full thread + an input row to talk to it.
 *
 * The only grounded way an overlay component learns its height is the
 * `visible` callback in overlayOptions — it runs every render cycle with the
 * terminal dimensions, so we capture termHeight there and lay out chrome
 * against it.
 *
 * Transcripts are fetched lazily per handle (rpc.getMessages → transcript
 * lines) and cached; while the focused subagent streams, text_delta events
 * are appended into the last streaming entry via applyDelta, and agent_settled
 * marks the cache stale so the next render cycle refetches the full thread.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";

import {
  applyDelta,
  condenseTranscript,
  finalizeStreaming,
  messagesToTranscript,
  previewText,
  renderTranscript,
  sanitizeStatusText,
  type SubagentRegistry,
  type SubagentRecord,
  type TranscriptMessage,
} from "./subagents.ts";
import { isRecord } from "./rpc-process.ts";

interface OverlayState {
  view: "overview" | "focus";
  cursor: number;
  termHeight: number;
  transcripts: Map<string, TranscriptMessage[]>;
  scroll: number;
}

const STATUS_GLYPHS: Record<SubagentRecord["status"], string> = {
  spawning: "…",
  running: "▸",
  idle: "·",
  stopped: "■",
  error: "✗",
};

export async function openAgentsOverlay(
  ctx: ExtensionCommandContext,
  registry: SubagentRegistry,
): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify("/agents is TUI-only", "warning");
    return;
  }
  if (registry.size === 0) {
    ctx.ui.notify("no subagents yet — spawn one with subagent_create", "info");
    return;
  }

  const state: OverlayState = {
    view: "overview",
    cursor: 0,
    termHeight: 24,
    transcripts: new Map(),
    scroll: 0,
  };

  await ctx.ui.custom<void>(
    (tui, theme, _kb, done) => {
      const th = theme as unknown as {
        fg(color: string, s: string): string;
        bg(color: string, s: string): string;
        bold(s: string): string;
      };
      const editor = new Input();
      const recordSubs = new Map<string, () => void>();
      let cached: string[] | undefined;
      let lastRenderWidth = 80;

      const requestRender = (tui as { requestRender(): void }).requestRender.bind(tui);
      const refresh = () => {
        cached = undefined;
        requestRender();
      };
      const selected = (): SubagentRecord | undefined => {
        const list = registry.list();
        return list[Math.min(state.cursor, Math.max(0, list.length - 1))];
      };

      // -- transcript fetching ------------------------------------------------

      const refetch = async (record: SubagentRecord) => {
        let messages: unknown[];
        try {
          messages = await record.rpc.getMessages();
        } catch {
          return; // worker died mid-session; keep the last cache
        }
        state.transcripts.set(record.handle, messagesToTranscript(messages));
        refresh();
      };

      // Subscribe the focused/selected record's event stream for live deltas.
      const trackRecord = (record: SubagentRecord | undefined) => {
        for (const [handle, unsub] of recordSubs) {
          if (!record || record.handle !== handle) {
            unsub();
            recordSubs.delete(handle);
          }
        }
        if (!record || recordSubs.has(record.handle)) return;
        const unsub = record.rpc.onEvent((event) => {
          if (!isRecord(event)) return;
          const msgs = state.transcripts.get(record.handle);
          if (!msgs) return;
          if (event.type === "message_update") {
            const ae = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : undefined;
            if (ae?.type === "text_delta" && typeof ae.delta === "string") {
              state.transcripts.set(record.handle, applyDelta(msgs, ae.delta));
              refresh();
            }
          } else if (event.type === "message_end") {
            state.transcripts.set(record.handle, finalizeStreaming(msgs));
            refresh();
          } else if (event.type === "agent_settled") {
            // Whole thread changed (tool results, new user message); refetch.
            state.transcripts.set(record.handle, finalizeStreaming(msgs));
            void refetch(record);
          }
        });
        recordSubs.set(record.handle, unsub);
      };

      const unsubRegistry = registry.subscribe(() => refresh());

      // -- input ----------------------------------------------------------------

      editor.onSubmit = (value: string) => {
        const text = value.trim();
        editor.setValue("");
        refresh();
        if (!text) return;
        if (text === "/agents") {
          done(undefined);
          return;
        }
        const record = selected();
        if (!record) return;
        const msgs = state.transcripts.get(record.handle);
        if (msgs) {
          state.transcripts.set(record.handle, [...msgs, { role: "user", text }]);
        }
        const delivery =
          record.status === "running"
            ? record.rpc.request("steer", { message: text })
            : record.rpc.request("prompt", { message: text });
        delivery.catch(() => {});
        refresh();
      };
      editor.onEscape = () => {
        editor.setValue("");
        refresh();
      };

      function maxScroll(record: SubagentRecord): number {
        const msgs = state.transcripts.get(record.handle) ?? [];
        let lines = 0;
        const wrapWidth = Math.max(1, lastRenderWidth - 2);
        for (const line of renderTranscript(msgs)) {
          lines += Math.max(1, Math.ceil(line.length / wrapWidth));
        }
        return Math.max(0, lines - viewportHeight());
      }

      function viewportHeight(): number {
        // termHeight − top/bottom margins (2) − chrome: header(1) + content
        // divider(1) + hint(1) + editor(1)
        return Math.max(1, state.termHeight - 6);
      }

      function handleInput(data: string) {
        if (state.view === "focus") {
          if (matchesKey(data, Key.escape)) {
            state.view = "overview";
            state.scroll = 0;
            editor.setValue("");
            refresh();
            return;
          }
          if (matchesKey(data, Key.ctrl("c"))) {
            const record = selected();
            if (record && record.status === "running") {
              record.rpc.abort().catch(() => {});
            } else {
              editor.setValue("");
            }
            refresh();
            return;
          }
          const record = selected();
          if (record) {
            if (matchesKey(data, Key.up)) {
              state.scroll = Math.max(0, state.scroll - 1);
              return refresh();
            }
            if (matchesKey(data, Key.down)) {
              state.scroll = Math.min(state.scroll + 1, maxScroll(record));
              return refresh();
            }
            if (matchesKey(data, Key.pageUp)) {
              state.scroll = Math.max(0, state.scroll - viewportHeight());
              return refresh();
            }
            if (matchesKey(data, Key.pageDown)) {
              state.scroll = Math.min(state.scroll + viewportHeight(), maxScroll(record));
              return refresh();
            }
          }
          editor.handleInput(data);
          refresh();
          return;
        }
        // overview
        if (matchesKey(data, Key.escape)) {
          done(undefined);
          return;
        }
        const list = registry.list();
        if (!list.length) return;
        if (matchesKey(data, Key.up)) {
          state.cursor = (state.cursor - 1 + list.length) % list.length;
          trackRecord(list[state.cursor]);
          void refetch(list[state.cursor]!);
          return refresh();
        }
        if (matchesKey(data, Key.down)) {
          state.cursor = (state.cursor + 1) % list.length;
          trackRecord(list[state.cursor]);
          void refetch(list[state.cursor]!);
          return refresh();
        }
        if (matchesKey(data, Key.enter)) {
          const record = list[Math.min(state.cursor, list.length - 1)];
          if (!record) return;
          state.view = "focus";
          state.scroll = 0;
          if (!state.transcripts.has(record.handle)) void refetch(record);
          trackRecord(record);
          refresh();
        }
      }

      // -- rendering --------------------------------------------------------------

      function render(width: number): string[] {
        if (cached) return cached;
        lastRenderWidth = width;
        const w = Math.max(1, width);
        const lines: string[] = [];
        const list = registry.list();
        const contentRows = Math.max(1, viewportHeight());
        const selection = selected();

        if (state.view === "overview") {
          lines.push(th.fg("accent", th.bold(`subagents (${list.length})`)));
          const leftWidth = Math.max(14, Math.floor(w * 0.4));
          const rightWidth = Math.max(8, w - leftWidth - 1);

          const leftRows: string[] = [];
          for (let i = 0; i < Math.min(list.length, contentRows); i++) {
            const record = list[i]!;
            const preview = previewText(
              sanitizeStatusText(record.lastMessage || record.currentText || "…"),
              leftWidth - 16,
            );
            const row = `${STATUS_GLYPHS[record.status]} ${record.type} ${record.handle} ${preview}`
              .slice(0, leftWidth)
              .padEnd(leftWidth, " ");
            leftRows.push(
              i === state.cursor
                ? th.bg("selectedBg", th.fg("text", row))
                : th.fg("dim", row),
            );
          }
          while (leftRows.length < contentRows) leftRows.push(" ".repeat(leftWidth));

          const msgs = selection ? state.transcripts.get(selection.handle) ?? [] : [];
          const condensed = condenseTranscript(msgs, contentRows).map((l) =>
            th.fg("muted", l.slice(0, rightWidth).padEnd(rightWidth, " ")),
          );

          const bodyRows = Math.min(contentRows, list.length || contentRows);
          for (let i = 0; i < bodyRows; i++) {
            lines.push(leftRows[i] + "│" + (i < condensed.length ? condensed[i] : " ".repeat(rightWidth)));
          }
          lines.push(th.fg("dim", "↑↓ select • enter focus • esc close"));
          return (cached = lines);
        }

        // focus view
        if (!selection) {
          done(undefined);
          return (cached = lines);
        }
        lines.push(
          th.fg("accent", th.bold(`focus: ${selection.type} ${selection.handle} ${selection.status}`)),
        );
        lines.push(th.fg("dim", "─".repeat(w)));

        const msgs = state.transcripts.get(selection.handle) ?? [];
        const allLines: string[] = [];
        for (const line of renderTranscript(msgs)) {
          const wrapped = wrapTextWithAnsi(line, Math.max(1, w - 2));
          allLines.push(...(wrapped.length ? wrapped : [""]));
        }
        if (selection.status === "running") {
          // streaming: pin to the newest lines (auto-follow)
          state.scroll = maxScroll(selection);
        }
        const start = Math.min(state.scroll, Math.max(0, allLines.length - contentRows));
        for (const line of allLines.slice(start, start + contentRows)) lines.push(" " + line);

        lines.push(th.fg("dim", "─".repeat(w)));
        lines.push(th.fg("dim", "type + enter send • ctrl+c interrupt • esc back • /agents + enter close"));
        lines.push(...editor.render(Math.max(1, w)));
        return (cached = lines);
      }

      return {
        render,
        handleInput,
        invalidate: () => {
          cached = undefined;
        },
        dispose() {
          unsubRegistry();
          for (const unsub of recordSubs.values()) unsub();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        width: "100%",
        maxHeight: "100%",
        margin: 1,
        visible: (_termWidth, termHeight) => {
          state.termHeight = termHeight;
          return true;
        },
      },
    },
  );
}