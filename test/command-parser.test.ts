import { describe, it, expect } from "vitest";
import {
  parseEscalationRequest,
  DEFAULT_INTERPRETER_PROGRAMS,
  type EscalationRequest,
} from "../src/parts/command-parser.js";

const interp = (program: string): EscalationRequest => ({
  simple: true,
  argv0: program,
  interpreter: true,
});

describe("parseEscalationRequest — simple commands", () => {
  it("bare command", () => {
    expect(parseEscalationRequest("git push")).toMatchObject({ simple: true, argv0: "git", interpreter: false });
  });
  it("strips leading env assignments", () => {
    expect(parseEscalationRequest("FOO=1 B=two git push")).toMatchObject({ simple: true, argv0: "git", interpreter: false });
  });
  it("env assignment with a quoted value", () => {
    expect(parseEscalationRequest('FOO="a b" git status')).toMatchObject({ simple: true, argv0: "git", interpreter: false });
  });
  it("resolves an absolute path to its basename", () => {
    expect(parseEscalationRequest("/usr/bin/git status")).toMatchObject({ simple: true, argv0: "git", interpreter: false });
  });
  it("quoted metacharacters are literal", () => {
    expect(parseEscalationRequest('echo "a && b"')).toMatchObject({ simple: true, argv0: "echo", interpreter: false });
  });
  it("quoted command args stay simple", () => {
    expect(parseEscalationRequest("git 'status' --porcelain")).toMatchObject({ simple: true, argv0: "git", interpreter: false });
  });
  it("cd path alone is simple with no argv0 (never a raw key)", () => {
    const r = parseEscalationRequest("cd /tmp");
    expect(r.simple).toBe(true);
    expect(r.argv0).toBeUndefined();
    expect(r.peelNote).toBeDefined();
  });
  it("bare cd alone is simple with no argv0", () => {
    const r = parseEscalationRequest("cd");
    expect(r.simple).toBe(true);
    expect(r.argv0).toBeUndefined();
  });
  it("pure env assignment with no command is simple, no argv0", () => {
    const r = parseEscalationRequest("FOO=1");
    expect(r.simple).toBe(true);
    expect(r.argv0).toBeUndefined();
  });
});

describe("parseEscalationRequest — cd peeling", () => {
  it("peels one leading cd && and keys on the real program", () => {
    const r = parseEscalationRequest("cd repo && git status");
    expect(r.simple).toBe(true);
    expect(r.argv0).toBe("git");
    expect(r.peelNote).toBeDefined();
  });
  it("peels one leading cd ;", () => {
    const r = parseEscalationRequest("cd /tmp; make");
    expect(r.simple).toBe(true);
    expect(r.argv0).toBe("make");
  });
  it("peels env then cd", () => {
    expect(parseEscalationRequest("FOO=1 cd repo && git status")).toMatchObject({ simple: true, argv0: "git" });
  });
  it("cd with a quoted path", () => {
    expect(parseEscalationRequest('cd "my dir" && git status')).toMatchObject({ simple: true, argv0: "git" });
  });
  it("a second cd chain stays compound", () => {
    const r = parseEscalationRequest("cd a && cd b && git status");
    expect(r.simple).toBe(false);
  });
  it("cd smuggling to a sensitive path still keys on the peeled program but must adjudicate if unlisted", () => {
    const r = parseEscalationRequest("cd / && cat /etc/shadow");
    expect(r.simple).toBe(true);
    expect(r.argv0).toBe("cat");
  });
});

describe("parseEscalationRequest — compound commands", () => {
  const compound = [
    "git push && cat ~/.ssh/id_rsa", // && chain smuggling past the argv0 gate
    "ls; rm -rf ~",
    "echo hi | bash",
    "foo &",
    "ls > /tmp/out",
    "(cd /tmp && ls)",
    "cat << EOF",
    "cat <<< hi",
  ];
  for (const cmd of compound) {
    it(`compound: ${cmd}`, () => {
      expect(parseEscalationRequest(cmd).simple).toBe(false);
    });
  }

  it("command substitution", () => {
    expect(parseEscalationRequest("git $(cat /etc/passwd)")).toMatchObject({ simple: false });
  });
  it("arithmetic substitution", () => {
    expect(parseEscalationRequest("echo $((1+1))")).toMatchObject({ simple: false, argv0: "echo" });
  });
  it("backticks", () => {
    expect(parseEscalationRequest("git `whoami`")).toMatchObject({ simple: false });
  });
  it("substitution inside double quotes still compounds", () => {
    expect(parseEscalationRequest('echo "$(id -u)"')).toMatchObject({ simple: false, argv0: "echo" });
  });
  it("newline joining", () => {
    expect(parseEscalationRequest("git status\ncat ~/.ssh/id_rsa")).toMatchObject({ simple: false });
  });
  it("trailing newline is just whitespace", () => {
    expect(parseEscalationRequest("git status\n")).toMatchObject({ simple: true, argv0: "git" });
  });
});

describe("parseEscalationRequest — wrapper programs", () => {
  const wrapped = [
    "sudo git status",
    "eval git status",
    "exec git status",
    "env FOO=1 git status",
    "nohup git status",
    "time git status",
    "xargs git status",
  ];
  for (const cmd of wrapped) {
    it(`${cmd} → not simple`, () => {
      expect(parseEscalationRequest(cmd).simple).toBe(false);
    });
  }
  it("sh -c recursion", () => {
    const r = parseEscalationRequest('sh -c "cat ~/.ssh/id_rsa"');
    expect(r.simple).toBe(false);
    expect(r.interpreter).toBe(true);
  });
  it("bash -c recursion with env first", () => {
    expect(parseEscalationRequest("FOO=1 bash -c evil").simple).toBe(false);
  });
  it("dash -c recursion", () => {
    expect(parseEscalationRequest('dash -c "rm -rf /"').simple).toBe(false);
  });
});

describe("parseEscalationRequest — interpreters", () => {
  it("each default interpreter program is flagged", () => {
    for (const program of DEFAULT_INTERPRETER_PROGRAMS) {
      expect(parseEscalationRequest(`${program} --version`)).toMatchObject(interp(program));
    }
  });
  it("a custom interpreter set via the param", () => {
    const set = new Set(["mylang", "foo"]);
    expect(parseEscalationRequest("mylang run script.py", set)).toMatchObject({ simple: true, argv0: "mylang", interpreter: true });
    expect(parseEscalationRequest("node -e x", set).interpreter).toBe(false); // not in custom set
    expect(parseEscalationRequest("foo bar", set)).toMatchObject({ simple: true, argv0: "foo", interpreter: true });
  });
  it("absolute interpreter path still flags by basename", () => {
    expect(parseEscalationRequest("/usr/bin/python3 -c x")).toMatchObject({ simple: true, argv0: "python3", interpreter: true });
  });
});

describe("parseEscalationRequest — fail-safe edges", () => {
  it("empty string is not executable and reports no argv0", () => {
    const r = parseEscalationRequest("");
    expect(r.simple).toBe(true);
    expect(r.argv0).toBeUndefined();
  });
  it("whitespace-only command", () => {
    expect(parseEscalationRequest("   ").argv0).toBeUndefined();
  });
  it("fails safe on exotica rather than claiming simple+executable", () => {
    // process substitution is compound
    expect(parseEscalationRequest("diff <(cat a) <(cat b)").simple).toBe(false);
  });
});