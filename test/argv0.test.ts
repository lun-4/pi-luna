import { describe, it, expect } from "vitest";
import { extractArgv0 } from "../src/parts/sandbox.js";

describe("extractArgv0", () => {
  it("bare command", () => {
    expect(extractArgv0("git push")).toBe("git");
  });
  it("strips leading env assignments", () => {
    expect(extractArgv0("FOO=1 B=two git push")).toBe("git");
  });
  it("resolves an absolute path to its basename", () => {
    expect(extractArgv0("/usr/bin/git status")).toBe("git");
  });
  it("strips a leading sudo", () => {
    expect(extractArgv0("sudo git status")).toBe("git");
    expect(extractArgv0("sudo -u root git status")).toBe("git");
  });
  it("handles env via sudo", () => {
    expect(extractArgv0("sudo FOO=1 make install")).toBe("make");
  });
  it("falls back to the literal first token for exotica", () => {
    expect(extractArgv0("(cd /tmp && ls)")).toBe("(cd");
    expect(extractArgv0("")).toBe("");
  });
  it("ignores leading whitespace", () => {
    expect(extractArgv0("   ls -la")).toBe("ls");
  });
});
