/**
 * Process-level resilience guards.
 *
 * A client that disconnects mid-response (a `curl` that times out and aborts
 * while the server is streaming a large body, a UI poll that navigates away)
 * makes the in-flight `res.write`/`res.end` throw a socket error — `EPIPE` or
 * `ECONNRESET`. With no `'uncaughtException'` listener, Node's default is to
 * print the stack and EXIT, which kills every in-flight run in the process.
 *
 * This installs a single process-wide guard that SWALLOWS those
 * client-disconnect errors (logs a warning, keeps serving) while still
 * crashing on genuine programming faults — a real bug should not be masked.
 * It is idempotent (guards against duplicate listeners) so it can be called
 * from every entry path (the Vite dev plugin via `mountSammyApi`, and the
 * standalone `serve.ts`) without stacking handlers.
 */

let __installed = false;

/** Error codes that mean "the client went away" — safe to ignore. */
const CLIENT_DISCONNECT_CODES = new Set(['EPIPE', 'ECONNRESET']);

/**
 * Install the process-level uncaught-exception / unhandled-rejection guards.
 * Idempotent: the first call wires the listeners, later calls are no-ops, so
 * it is safe to invoke from multiple entry points.
 */
export function installProcessGuards(): void {
  if (__installed) return;
  __installed = true;

  process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
    if (err && err.code && CLIENT_DISCONNECT_CODES.has(err.code)) {
      console.warn('[sammy] ignored client-disconnect:', err.code);
      return;
    }
    console.error('[sammy] uncaughtException:', err);
    process.exit(1);
  });

  process.on('unhandledRejection', reason => {
    console.error('[sammy] unhandledRejection:', reason);
  });
}
