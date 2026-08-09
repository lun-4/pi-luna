/**
 * bell part: ringBell() writes \x07 only on a real terminal (isTTY).
 *
 * The isTTY guard is the RPC-safety invariant: under --mode rpc (subagent
 * workers) stdout is a JSONL control channel, so a stray BEL byte would glue
 * onto the next JSON frame and corrupt parsing (rpc-process.ts). sandbox.ts
 * loads in every worker, so ringBell must be inert on a pipe.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { ringBell } from "../src/parts/bell.js";

// isTTY is not always an own property (inherited getter in some runtimes) —
// stub it with our own, and `delete` to restore whatever the prototype had.
const spies: ReturnType<typeof vi.spyOn>[] = [];
afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  spies.length = 0;
  delete (process.stdout as unknown as { isTTY?: unknown }).isTTY;
});

function stubStdout(isTTY: boolean) {
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
  spies.push(spy);
  return spy;
}

describe("ringBell", () => {
  it("writes \\x07 once when stdout is a TTY", () => {
    const spy = stubStdout(true);
    ringBell();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("\x07");
  });

  it("writes nothing when stdout is a pipe (RPC worker)", () => {
    const spy = stubStdout(false);
    ringBell();
    expect(spy).not.toHaveBeenCalled();
  });
});