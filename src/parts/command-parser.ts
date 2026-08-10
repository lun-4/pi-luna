/**
 * Conservative single-simple-command parser for the `sandbox:false` gate.
 *
 * The gate must decide, from the verbatim command string alone, whether the
 * request is *provably* a single simple command — no compound chains, no
 * command substitution, no heredocs, no backgrounding — so that an allowlist
 * rule keyed on argv0 can never be bypassed by `&&`, `;`, `|`, newlines,
 * `$(...)`, backticks, or a `cd` trampoline.
 *
 * Anything the scanner cannot prove simple is treated as compound (fail-safe):
 * compound requests never silently auto-allow and always reach adjudication
 * (the interactive menu, or the auto-mode classifier).
 */

import { basename } from "node:path";

export interface EscalationRequest {
  /** Provably a single simple command after peeling env assignments and one leading `cd`. */
  simple: boolean;
  /** Basename of the peeled remainder's first word (undefined when the remainder is empty, e.g. bare `cd`). */
  argv0?: string;
  /** argv0 ∈ interpreter set — interpreters never silently auto-allow. */
  interpreter: boolean;
  /** Human note about what was peeled (e.g. "peeled leading `cd repo &&`"). */
  peelNote?: string;
}

/** Bare-program interpreters that can smuggle arbitrary code behind an allowlisted argv0. */
export const DEFAULT_INTERPRETER_PROGRAMS: ReadonlySet<string> = new Set([
  "node",
  "python",
  "python3",
  "bash",
  "sh",
  "zsh",
  "perl",
  "ruby",
  "php",
  "lua",
  "deno",
  "bun",
  "pwsh",
  "powershell",
  "awk",
]);

/** Leading wrapper programs that recurse into further shell behavior; always treated as compound. */
const COMPOUND_TRIGGER_WORDS = new Set([
  "sudo",
  "eval",
  "exec",
  "env",
  "nohup",
  "time",
  "xargs",
]);

/** `sh -c`/`bash -c`-style recursion — the interpreter string is the real payload. */
const SHELL_C_WORDS = new Set(["sh", "bash", "zsh", "dash", "fish"]);

type LexItem =
  | { type: "word"; value: string; quoted: boolean }
  | { type: "sep"; value: string };

/**
 * Lex the command into top-level words and separators, quote/escape-aware.
 * Quoted metacharacters are part of the word (literal); unquoted metacharacters
 * (including `$(`/`$((` and backticks even inside double quotes, since those
 * still execute) become separators.
 */
function lex(command: string): LexItem[] {
  const items: LexItem[] = [];
  let i = 0;
  const n = command.length;
  let mode: "normal" | "single" | "double" = "normal";
  let escaped = false;
  let word = "";
  let wordQuoted = false;

  const flushWord = () => {
    if (word !== "" || wordQuoted) {
      items.push({ type: "word", value: word, quoted: wordQuoted });
    }
    word = "";
    wordQuoted = false;
  };
  const pushSep = (value: string) => {
    flushWord();
    items.push({ type: "sep", value });
  };

  while (i < n) {
    const c = command[i];

    if (escaped) {
      // Escaped char is literal — never a metacharacter.
      word += c;
      i++;
      escaped = false;
      continue;
    }

    if (mode === "single") {
      if (c === "'") mode = "normal";
      else word += c;
      i++;
      continue;
    }

    if (mode === "double") {
      if (c === '"') {
        mode = "normal";
      } else if (c === "\\") {
        // Backslash escapes one of $ ` " \ newline inside double quotes.
        if (i + 1 < n && "$`\"\\".includes(command[i + 1])) {
          word += command[i + 1];
          i += 2;
          continue;
        }
        word += c; // literal backslash
      } else if (c === "$" && command[i + 1] === "(") {
        // Command substitution executes even inside double quotes.
        pushSep("$(");
        i += 2;
        continue;
      } else if (c === "`") {
        pushSep("`");
      } else {
        word += c;
      }
      i++;
      continue;
    }

    // normal mode
    if (c === "\\") {
      escaped = true;
      i++;
      continue;
    }
    if (c === "'") {
      mode = "single";
      wordQuoted = true;
      i++;
      continue;
    }
    if (c === '"') {
      mode = "double";
      wordQuoted = true;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      if (c === "\n") {
        // A newline separating more content is a command joiner (compound);
        // a trailing newline is just whitespace.
        let j = i + 1;
        while (j < n && /\s/.test(command[j])) j++;
        if (j < n) {
          pushSep("\n");
          i = j;
          continue;
        }
      }
      flushWord();
      i++;
      continue;
    }

    const rest = command.slice(i);
    if (rest.startsWith("&&")) { pushSep("&&"); i += 2; continue; }
    if (rest.startsWith("||")) { pushSep("||"); i += 2; continue; }
    if (rest.startsWith("<<<")) { pushSep("<<<"); i += 3; continue; }
    if (rest.startsWith("<<")) { pushSep("<<"); i += 2; continue; }
    if (rest.startsWith("$((")) { pushSep("$(("); i += 3; continue; }
    if (rest.startsWith("$(")) { pushSep("$("); i += 2; continue; }
    if ("|;&()<>`".includes(c)) { pushSep(c); i++; continue; }
    if (c === "\n") { pushSep("\n"); i++; continue; }
    word += c;
    i++;
  }
  flushWord();
  return items;
}

/** Extract the basename of a command word (handles leading paths). */
function commandBasename(word: string): string {
  return basename(word);
}

/**
 * Classify a verbatim `sandbox:false` command.
 *
 * @param command        the verbatim command string
 * @param interpreterSet set of bare program names that are interpreters
 *                       (defaults to `DEFAULT_INTERPRETER_PROGRAMS`; the gate
 *                       passes the configured override set)
 */
export function parseEscalationRequest(
  command: string,
  interpreterSet: ReadonlySet<string> = DEFAULT_INTERPRETER_PROGRAMS,
): EscalationRequest {
  const items = lex(command);
  let i = 0;

  // 1. Peel leading VAR=value assignments (env-carrying syntax). Any leading
  //    `NAME=...` word is an assignment, quoted value or not — commands can't
  //    contain `=` in the name position.
  while (i < items.length) {
    const it = items[i];
    if (it.type !== "word" || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(it.value)) break;
    i++;
  }

  // 2. Peel at most ONE leading `cd <path> &&|;` (or plain `cd <path>` / bare
  //    `cd`). One peel only: `cd a && cd b && x` stays compound. `cd` is never
  //    itself a raw-gate key — the peeled remainder's argv0 is.
  let peelNote: string | undefined;
  {
    const it = items[i];
    if (it && it.type === "word" && !it.quoted && it.value === "cd") {
      i++;
      const path = items[i];
      if (path && path.type === "word") i++; // path
      const sep = items[i];
      if (sep && sep.type === "sep" && (sep.value === "&&" || sep.value === ";")) {
        i++;
      }
      peelNote = "peeled leading `cd`";
    }
  }

  const body = items.slice(i);
  const firstWordItem = body.find((it) => it.type === "word");
  const argv0 = firstWordItem?.type === "word" ? commandBasename(firstWordItem.value) : undefined;
  const interpreter = !!argv0 && interpreterSet.has(argv0);

  // 3. Any remaining separator ⇒ compound (fail-safe: unparseable ⇒ compound).
  if (body.some((it) => it.type === "sep")) {
    return { simple: false, argv0, interpreter, peelNote };
  }

  const firstWord = body[0]?.type === "word" ? body[0].value : undefined;

  // 4. Leading wrappers that recurse into shell parsing.
  if (firstWord !== undefined && COMPOUND_TRIGGER_WORDS.has(firstWord)) {
    return { simple: false, argv0, interpreter, peelNote };
  }

  // 5. `sh -c "..."` / `bash -c "..."` recursion — the trailing string is the
  //    real command and is not scanned for compounding.
  if (
    firstWord !== undefined &&
    SHELL_C_WORDS.has(firstWord) &&
    body[1]?.type === "word" &&
    body[1].value === "-c"
  ) {
    return { simple: false, argv0, interpreter, peelNote };
  }

  return { simple: true, argv0, interpreter, peelNote };
}