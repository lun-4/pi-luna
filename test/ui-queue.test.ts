import { describe, it, expect, beforeEach } from "vitest";
import {
  createSerializedUI,
  serializedUI,
  resetSerializedUIQueue,
} from "../src/parts/ui-queue.js";

interface SelectFn {
  (title: string, options?: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
}

/** A select that blocks until the test releases it. */
function gatedSelect(order: string[], releases: Array<() => void>): SelectFn {
  return (async (title: string) => {
    order.push(`open:${title}`);
    await new Promise<void>((r) => releases.push(r));
    return title;
  }) as SelectFn;
}

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("serializedUI", () => {
  beforeEach(() => resetSerializedUIQueue());

  it("never shows two dialogs at once; queues FIFO and returns in order", async () => {
    const order: string[] = [];
    const releases: Array<() => void> = [];
    const ui = createSerializedUI({ select: gatedSelect(order, releases) });

    const p1 = ui.select("A");
    const p2 = ui.select("B");
    const p3 = ui.select("C");
    await tick();

    // Only the first dialog is up; the others wait.
    expect(order).toEqual(["open:A"]);

    releases[0]!();
    await tick();
    expect(order).toEqual(["open:A", "open:B"]);

    releases[1]!();
    await tick();
    expect(order).toEqual(["open:A", "open:B", "open:C"]);

    releases[2]!();
    expect(await Promise.all([p1, p2, p3])).toEqual(["A", "B", "C"]);
  });

  it("shares the queue across separate serializedUI instances (cross-part race)", async () => {
    const order: string[] = [];
    const releases: Array<() => void> = [];
    const sandboxUi = createSerializedUI({ select: gatedSelect(order, releases) });
    const askUi = createSerializedUI({ select: gatedSelect(order, releases) });

    const p1 = sandboxUi.select("sandbox-approval");
    const p2 = askUi.select("ask-question");
    await tick();
    expect(order).toEqual(["open:sandbox-approval"]); // ask waits for sandbox

    releases[0]!();
    await tick();
    expect(order).toEqual(["open:sandbox-approval", "open:ask-question"]);

    releases[1]!();
    expect(await Promise.all([p1, p2])).toEqual(["sandbox-approval", "ask-question"]);
  });

  it("passes non-dialog methods through untouched", async () => {
    const inner = {
      setStatus: () => "ok",
      select: (async () => "x") as SelectFn,
    };
    const ui = createSerializedUI(inner);
    expect(ui.setStatus()).toBe("ok");
  });

  it("returns undefined without showing when the signal is already aborted", async () => {
    const called: string[] = [];
    const ac = new AbortController();
    ac.abort();
    const ui = createSerializedUI({
      select: (async (title: string) => {
        called.push(title);
        return title;
      }) as SelectFn,
    });
    const result = await ui.select("A", [], { signal: ac.signal });
    expect(result).toBeUndefined();
    expect(called).toEqual([]);
  });

  it("cancels a queued dialog when its signal aborts while waiting", async () => {
    const ac = new AbortController();
    const order: string[] = [];
    const releases: Array<() => void> = [];
    const ui = createSerializedUI({ select: gatedSelect(order, releases) });

    const p1 = ui.select("A");
    const p2 = ui.select("B", [], { signal: ac.signal });
    ac.abort(); // B is queued behind A; aborting must cancel it without showing
    await tick();

    releases[0]!();
    expect(await p1).toBe("A");
    expect(await p2).toBeUndefined();
  });

  it("an aborted queued dialog does not stall the queue", async () => {
    const order: string[] = [];
    const releases: Array<() => void> = [];
    const ui = createSerializedUI({ select: gatedSelect(order, releases) });

    const aborted = new AbortController();
    const p1 = ui.select("A");
    const p2 = ui.select("B", [], { signal: aborted.signal });
    aborted.abort();
    const p3 = ui.select("C");

    await tick();
    expect(order).toEqual(["open:A"]); // B skipped, C still waiting behind A

    releases[0]!();
    await tick();
    expect(order).toEqual(["open:A", "open:C"]); // B never showed

    releases[1]!();
    expect(await Promise.all([p1, p2, p3])).toEqual(["A", undefined, "C"]);
  });

  it("serializedUI is the shared-queue flavor", async () => {
    const order: string[] = [];
    const releases: Array<() => void> = [];
    const ui = serializedUI({ select: gatedSelect(order, releases) });
    const p1 = ui.select("X");
    const p2 = ui.select("Y");
    await tick();
    expect(order).toEqual(["open:X"]);
    releases[0]!();
    await tick();
    expect(order).toEqual(["open:X", "open:Y"]);
    releases[1]!();
    await Promise.all([p1, p2]);
  });

  it("wrapping an already-wrapped ui is a no-op (no double-wrap deadlock)", async () => {
    const order: string[] = [];
    const releases: Array<() => void> = [];
    const raw = { select: gatedSelect(order, releases) };
    const once = createSerializedUI(raw);
    const twice = serializedUI(once); // e.g. a gate wrapping an already-serialized ctx.ui
    expect(twice).toBe(once);

    const p = twice.select("A");
    await tick();
    expect(order).toEqual(["open:A"]);
    releases[0]!();
    expect(await p).toBe("A");
  });
});
