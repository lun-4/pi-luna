/**
 * agents overlay — /agents split-pane view over live subagents
 *
 * One stable two-pane screen: left = subagent list (≈40% width, one row per
 * subagent: glyph type handle preview, cursor highlighted, spawn/delete
 * live-updating); right = live state of the selection (status line + divider +
 * wrapped transcript, auto-following newest lines while the subagent runs,
 * pgup/pgdn to scroll back). Bottom: input row; enter sends to the selection
 * (steer while running / prompt when idle), ctrl+c aborts a running selection,
 * esc clears the input then closes. The selection is stable by handle —
 * spawns/deletes update the list without yanking the right pane.
 *
 * The only grounded way an overlay component learns its height is the
 * `visible` callback in overlayOptions — it runs every render cycle with the
 * terminal dimensions, so we capture termHeight there and lay out chrome
 * against it.
 *
 * Transcripts are fetched lazily per handle (rpc.getMessages → transcript
 * lines) and cached; while the selected subagent streams, text_delta events
 * are appended into the last streaming entry via applyDelta, and agent_settled
 * marks the cache stale so the next render cycle refetches the full thread.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, type TUI } from "@earendil-works/pi-tui";

import {
  applyDelta,
  finalizeStreaming,
  messagesToTranscript,
  previewText,
  renderTranscript,
  sanitizeStatusText,
  windowTranscript,
  type SubagentRegistry,
  type SubagentRecord,
  type TranscriptMessage,
} from "./subagents.ts";
import { isRecord } from "./rpc-process.ts";

interface OverlayState {
  selectedHandle: string | undefined;
  cursor: number; // index into registry.list() — kept in sync with selectedHandle
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
    selectedHandle: undefined,
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
      let lastRightWidth = 40;

      const requestRender = (tui as { requestRender(): void }).requestRender.bind(tui);
      const refresh = () => {
        cached = undefined;
        requestRender();
      };

      // -- selection ------------------------------------------------------------

      const selected = (): SubagentRecord | undefined => {
        const list = registry.list();
        if (!list.length) return undefined;
        const found = list.find((r) => r.handle === state.selectedHandle);
        return found ?? list[Math.min(state.cursor, list.length - 1)];
      };

      /** Switch the selection: track its RPC stream, fetch its thread, reset scroll. */
      const select = (record: SubagentRecord) => {
        state.selectedHandle = record.handle;
        const list = registry.list();
        state.cursor = Math.max(0, list.indexOf(record));
        state.scroll = 0;
        trackRecord(record);
        void refetch(record);
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

      // Subscribe the selected record's event stream for live deltas.
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
            // A message committed; the thread grew (new toolCall entries).
            state.transcripts.set(record.handle, finalizeStreaming(msgs));
            void refetch(record);
            refresh();
          } else if (event.type === "tool_execution_end") {
            // Tool result landed: refresh the thread so tool: lines stream in.
            void refetch(record);
          } else if (event.type === "agent_settled") {
            // Whole thread changed (tool results, new user message); refetch.
            state.transcripts.set(record.handle, finalizeStreaming(msgs));
            void refetch(record);
          }
        });
        recordSubs.set(record.handle, unsub);
      };

      // Seed the selection immediately so the right pane populates on open.
      const initial = registry.list()[0];
      if (initial) select(initial);

      // Stable-selection registry handler: spawns/deletes must not yank the
      // right pane elsewhere, but status changes still refresh the rows.
      const unsubRegistry = registry.subscribe(() => {
        const list = registry.list();
        if (!list.length) {
          state.selectedHandle = undefined;
        } else {
          const idx = list.findIndex((r) => r.handle === state.selectedHandle);
          if (idx >= 0) state.cursor = idx; // still selected (e.g. status/usage notify): just resync cursor
          else select(list[Math.min(state.cursor, list.length - 1)]!); // selection vanished: nearest fallback
        }
        refresh();
      });

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

      function viewportHeight(): number {
        // termHeight − top/bottom margins (2) − chrome: header(1) + hint(1) + editor(1)
        return Math.max(1, state.termHeight - 5);
      }

      function transcriptRows(): number {
        // right pane: status line + divider eat the first two content rows
        return Math.max(1, viewportHeight() - 2);
      }

      function maxScroll(msgs: TranscriptMessage[]): number {
        const wrapWidth = Math.max(1, lastRightWidth - 2);
        let lines = 0;
        for (const line of renderTranscript(msgs)) {
          lines += Math.max(1, Math.ceil(line.length / wrapWidth));
        }
        return Math.max(0, lines - transcriptRows());
      }

      function handleInput(data: string) {
        if (matchesKey(data, Key.escape)) {
          if (editor.getValue().length > 0) {
            editor.setValue("");
            refresh();
          } else {
            done(undefined); // closes the overlay
          }
          return;
        }
        const list = registry.list();
        if (!list.length) return;
        const current = list[Math.min(state.cursor, list.length - 1)]!;
        if (matchesKey(data, Key.up)) {
          select(list[(state.cursor - 1 + list.length) % list.length]!);
          return refresh();
        }
        if (matchesKey(data, Key.down)) {
          select(list[(state.cursor + 1) % list.length]!);
          return refresh();
        }
        if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
          const msgs = state.transcripts.get(current.handle) ?? [];
          if (matchesKey(data, Key.pageUp)) {
            state.scroll = Math.max(0, state.scroll - transcriptRows());
          } else {
            state.scroll = Math.min(state.scroll + transcriptRows(), maxScroll(msgs));
          }
          return refresh();
        }
        if (matchesKey(data, Key.ctrl("c"))) {
          if (current.status === "running") {
            current.rpc.abort().catch(() => {});
          } else {
            editor.setValue("");
          }
          return refresh();
        }
        editor.handleInput(data);
        refresh();
      }

      // -- rendering --------------------------------------------------------------

      function render(width: number): string[] {
        if (cached) return cached;
        lastRenderWidth = width;
        const w = Math.max(1, width);
        const lines: string[] = [];
        const list = registry.list();
        const contentRows = viewportHeight();
        const selection = selected();

        lines.push(th.fg("accent", th.bold(`subagents (${list.length})`)));

        const leftWidth = Math.max(14, Math.min(Math.floor(w * 0.4), w - 9));
        const rightWidth = Math.max(1, w - leftWidth - 1); // never overflows w, even at <23 cols
        lastRightWidth = rightWidth;

        // -- left pane: the subagents -------------------------------------------------
        const leftRows: string[] = [];
        for (let i = 0; i < contentRows; i++) {
          const record = list[i];
          if (!record) {
            leftRows.push(" ".repeat(leftWidth));
            continue;
          }
          const preview = previewText(
            sanitizeStatusText(record.lastMessage || record.currentText || "…"),
            Math.max(0, leftWidth - 16), // guard: previewText slices are unicode-safe, negative would drop tail chars
          );
          const row = `${STATUS_GLYPHS[record.status]} ${record.type} ${record.handle} ${preview}`
            .slice(0, leftWidth)
            .padEnd(leftWidth, " ");
          leftRows.push(i === state.cursor ? th.bg("selectedBg", th.fg("text", row)) : th.fg("dim", row));
        }

        // -- right pane: current state of the selection --------------------------------
        const rightRows: string[] = [];
        if (!selection) {
          rightRows.push(th.fg("dim", "no subagents".padEnd(rightWidth, " ")));
        } else {
          const header =
            `${STATUS_GLYPHS[selection.status]} ${selection.type} ${selection.handle} ${selection.status}`;
          rightRows.push(th.fg("accent", th.bold(header.slice(0, rightWidth).padEnd(rightWidth, " "))));
          rightRows.push(th.fg("dim", "─".repeat(rightWidth)));
          const msgs = state.transcripts.get(selection.handle);
          const rows = transcriptRows();
          if (msgs) {
            const windowed = windowTranscript(
              msgs,
              rows,
              Math.max(1, rightWidth - 2),
              state.scroll,
              selection.status === "running", // auto-follow newest while streaming
            );
            state.scroll = windowed.scroll;
            for (const line of windowed.lines) {
              rightRows.push(th.fg("muted", (" " + line).slice(0, rightWidth).padEnd(rightWidth, " ")));
            }
          } else {
            rightRows.push(th.fg("dim", "…".padEnd(rightWidth, " "))); // thread still fetching
          }
        }
        while (rightRows.length < contentRows) rightRows.push(" ".repeat(rightWidth));

        for (let i = 0; i < contentRows; i++) {
          lines.push(leftRows[i] + "│" + rightRows[i]);
        }

        lines.push(th.fg("dim", "↑↓ select • enter send • ctrl+c interrupt • esc close".slice(0, w)));
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