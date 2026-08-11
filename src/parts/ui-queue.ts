/**
 * Shared serialization for pi's blocking extension dialogs.
 *
 * pi's interactive TUI gives extensions exactly ONE modal dialog slot:
 * `ui.select` / `ui.confirm` / `ui.input` are all rendered into the same
 * `extensionSelector` field. A second call while one is up silently replaces
 * the first WITHOUT resolving its promise (`dispose()` only stops the
 * countdown timer; it never fires the cancel callback). So anything awaiting
 * the first dialog — usually a blocked agent tool call — hangs forever.
 *
 * Consequence: when an agent fires two tool calls in a single turn that both
 * need blocking UI (e.g. two `sandbox:false` bash calls reaching the approval
 * menu, or two `ask` calls), only the last prompt ever shows in the UI and the
 * first tool call never completes.
 *
 * `serializedUI` wraps a ui object and funnels every blocking dialog through a
 * module-wide FIFO, so prompts from different parts (sandbox gate, ask, …)
 * queue instead of racing: the next dialog is only shown after the previous
 * one has been answered, dismissed, or timed out. Abort signals are honored
 * both while queued and at show time — a dialog that pi would have dismissed
 * for an aborted call is never shown, and the caller gets `undefined` (the
 * "cancelled" result) immediately.
 *
 * All non-dialog methods (setStatus, notify, …) pass through unchanged.
 */

interface DialogOpts {
  signal?: AbortSignal;
  timeout?: number;
}

/** Module-global FIFO tail shared by every serializedUI instance. */
let tail: Promise<void> = Promise.resolve();

/** Proxies we've already wrapped, so re-wrapping is a no-op (no double-wrap deadlock). */
const wrapped = new WeakSet<object>();

/** Reset the shared queue (test seam). */
export function resetSerializedUIQueue(): void {
  tail = Promise.resolve();
}

/**
 * Wrap a ui-like object so `select`/`confirm`/`input` are serialized through
 * the shared FIFO. Returns the same shape via a Proxy; other methods are
 * passed through untouched. Wrapping an already-wrapped ui is a no-op.
 */
export function createSerializedUI<UI extends object>(ui: UI): UI {
  if (wrapped.has(ui)) return ui;
  const dialog =
    <T>(value: Function) =>
    (...args: unknown[]): Promise<T> => {
      const opts = args[2] as DialogOpts | undefined;
      // Already aborted before it could show → cancel immediately.
      if (opts?.signal?.aborted) return Promise.resolve(undefined as T);
      // Wait for every earlier dialog to finish, then (re)check the signal
      // right before showing. `tail` records when THIS dialog is done so the
      // next caller only starts after we've been answered.
      const p = tail.then(() => {
        if (opts?.signal?.aborted) return undefined as T;
        return Reflect.apply(value, ui, args);
      });
      tail = p.then(
        () => undefined,
        () => undefined,
      );
      return p;
    };

  const proxy = new Proxy(ui, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (
        (prop === "select" || prop === "confirm" || prop === "input") &&
        typeof value === "function"
      ) {
        return dialog(value);
      }
      return value;
    },
  });
  wrapped.add(proxy);
  return proxy;
}

/**
 * Like {@link createSerializedUI}, but guaranteed to share the module-wide
 * queue so separate parts (sandbox gate, ask) cannot race each other.
 */
export function serializedUI<UI extends object>(ui: UI): UI {
  return createSerializedUI(ui);
}