/**
 * The gate's typed refusal.
 *
 * `main` prints a GateError as "cannot run — <message>" and exits 2, and prints
 * anything else as an unexpected error with its stack. It lives on its own so a
 * module extracted from the gate — the worktree lock — can throw the same class
 * without importing the script that uses it.
 */
export class GateError extends Error {}
