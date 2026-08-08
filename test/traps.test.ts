import { describe, it, expect } from "vitest";
import { TrapParser, formatDenials, type Trap } from "../src/parts/sandbox.js";

const FS_TRAP: Trap = {
  kind: "filesystem",
  code: "FILESYSTEM_DENIED",
  state: "info",
  query_id: "0",
  operation: "write",
  path: "/home/luna/.ssh/config",
  requested_path: "/home/luna/.ssh/config",
  syscall: "openat",
  errno: "EACCES",
  flags: [],
  reason: "allow_miss",
  suggested_grant: { allowWrite: "/home/luna/.ssh" },
  process: { pid: 1, exe: "/bin/cp", cwd: "/tmp" },
  mechanism: "seccomp",
};

describe("TrapParser", () => {
  it("parses a filesystem denial line", () => {
    const p = new TrapParser();
    p.feed(Buffer.from(JSON.stringify(FS_TRAP) + "\n"));
    const { traps, passthrough } = p.finish();
    expect(traps).toHaveLength(1);
    expect(traps[0]).toMatchObject({ kind: "filesystem", code: "FILESYSTEM_DENIED" });
    expect(passthrough).toHaveLength(0);
  });

  it("passes through non-JSON stderr", () => {
    const p = new TrapParser();
    p.feed(Buffer.from("bash: something: command not found\n"));
    const { traps, passthrough } = p.finish();
    expect(traps).toHaveLength(0);
    expect(passthrough).toEqual(["bash: something: command not found"]);
  });

  it("rejects JSON that is not a trap", () => {
    const p = new TrapParser();
    p.feed(Buffer.from(JSON.stringify({ hello: "world" }) + "\n"));
    p.feed(Buffer.from(JSON.stringify(["array"]) + "\n"));
    p.feed(Buffer.from(JSON.stringify("bare string") + "\n"));
    const { traps, passthrough } = p.finish();
    expect(traps).toHaveLength(0);
    expect(passthrough).toHaveLength(3);
  });

  it("handles a JSON line split across two reads", () => {
    const line = JSON.stringify(FS_TRAP) + "\n";
    const p = new TrapParser();
    p.feed(Buffer.from(line.slice(0, 30)));
    p.feed(Buffer.from(line.slice(30)));
    const { traps } = p.finish();
    expect(traps).toHaveLength(1);
  });

  it("handles a partial final line with no newline", () => {
    const p = new TrapParser();
    p.feed(Buffer.from(JSON.stringify(FS_TRAP))); // no trailing \n
    const { traps } = p.finish();
    expect(traps).toHaveLength(1);
  });

  it("accepts network / launch / usage / internal kinds", () => {
    const lines = [
      { kind: "network", code: "NETWORK_DENIED", state: "info", query_id: "0", operation: "connect", target: "github.com:443", syscall: "connect", errno: "EACCES", mechanism: "seccomp", process: { pid: 1, exe: null, cwd: null } },
      { kind: "launch", code: "LAUNCH_FAILED", program: "nope", message: "not found" },
      { kind: "usage", code: "USAGE_ERROR", message: "bad flag" },
      { kind: "internal", code: "SANDBOX_SETUP_FAILED", mechanism: "seccomp", message: "busy" },
    ];
    const p = new TrapParser();
    p.feed(Buffer.from(lines.map((l) => JSON.stringify(l)).join("\n") + "\n"));
    const { traps } = p.finish();
    expect(traps.map((t) => t.code)).toEqual([
      "NETWORK_DENIED",
      "LAUNCH_FAILED",
      "USAGE_ERROR",
      "SANDBOX_SETUP_FAILED",
    ]);
  });
});

describe("formatDenials", () => {
  it("summarises filesystem and network denials", () => {
    const note = formatDenials([
      FS_TRAP,
      { kind: "network", code: "NETWORK_DENIED", state: "info", query_id: "0", operation: "connect", target: "github.com:443", syscall: "connect", errno: "EACCES", mechanism: "seccomp", process: { pid: 1, exe: null, cwd: null } },
    ]);
    expect(note).toContain("Sandbox: this command was denied");
    expect(note).toContain("write /home/luna/.ssh/config");
    expect(note).toContain("connect github.com:443");
    expect(note).toContain("sandbox: false");
  });

  it("returns undefined when there are no denial traps", () => {
    expect(formatDenials([])).toBeUndefined();
    expect(formatDenials([{ kind: "internal", code: "SANDBOX_SETUP_FAILED", message: "busy" }])).toBeUndefined();
  });
});
