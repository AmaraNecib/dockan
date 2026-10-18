# Enumerate every write site, not the ones you remember: a lost-lock flag that gated 4 of 6 writers

**Date:** 2026-10-18 · **Ticket:** 275 · **Area:** apps/api/src/main.ts, apps/api/src/lib/vault/lock.ts

The ADR asked for a "stop writing once the lock is lost" rule. The first implementation added a
`lockLost` flag and checked it at four sites — every one of which guarded `dokan.db.enc`. It was
correct at all four.

It was still wrong, because the write path had six entrances, not four. The stdin broker's `reset`
and `unlock` branches, `commitSetup()`, and `cleanupLegacyPlaintext()` all wrote into the data folder
after the loss. Two independent review lenses found it from different directions: the debate lens from
"where can the loser still reach a writer", the code-review lens from "criterion 6 is only partly
met". Neither had to be lucky — the sites are enumerable.

**The rule:** when a new guard is a *global* invariant ("nobody writes to a folder this instance no
longer owns"), find the sites by search, not from memory. Grep the writers — the file names, the
fs calls, the module boundaries — and check the flag at each one. Then write a test per site, because
a flag checked at four of six sites is indistinguishable from a flag checked at zero until you do.

**Corollary:** a guard that is only reachable from one entry point is a guess about the program's
shape. Here the guard looked complete because the obvious entry point (the HTTP mutation path) was
covered. The untested entry point (the shell) was the one that mattered.

**Detection that worked:** ablation. Revert the guard, run the suite. If nothing fails, the test is
not testing the guard. That is cheaper than reading for missed sites and it caught the same defect a
second time in round 3 (the shutdown-skip test was vacuous because the abandoned connection was
never dirty, so `checkpoint()` early-returned).
