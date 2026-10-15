# Design — #193 (load-sensitive 201-supplier test) + #202 (vault spec hardcoded ports)

**Tier:** Standard (test + docs only; no app/contract/schema change).
**Base:** `origin/develop` @ `f757211` (the local `develop` ref is stale at
`8579fcf`; all comparisons use `origin/develop`).

## Scope

Two pre-existing gate costs, both in tests:

1. **#202** — `tests/e2e/vault.spec.ts` hardcodes its own API/web pair at
   `4399`/`5174`, overriding `DOKAN_PORT`/`DOKAN_WEB_PORT`. Two lanes running a
   full suite therefore reach the *same* vault servers (the reported symptom is
   a foreign lane answering `VAULT_SETUP_IN_PROGRESS`), so vault-touching e2e
   runs had to be serialized across lanes.
2. **#193** — `SupplierOpeningBalancePage`'s 201-supplier test
   (`apps/web/src/pages/supplier-opening-balance.test.tsx`) fails under turbo
   load and passes in isolation. It already carries a `60_000` bound (added with
   the test in #176/#177), so the failure is not Bun's 5 s default; the test's
   wall-clock is load-sensitive and the bound is exceeded.

## Public interface / seam

### #202 — two new environment variables (test-only)

| Variable | Default | Meaning |
| --- | --- | --- |
| `DOKAN_VAULT_PORT` | `4399` | API port for the vault spec's dedicated pair |
| `DOKAN_VAULT_WEB_PORT` | `5174` | web port for the vault spec's dedicated pair |

Defaults are the current literals, so every existing local and CI invocation is
unchanged. The spec still spawns the same two children; it now *resolves* the
ports once at module load and every consumer (spawn env, health poll, status
poll, navigation) reads those resolved constants.

Resolution rule mirrors `playwright.config.ts`: `Number(process.env.X ?? default)`.
No app code reads these variables — they exist only so the spec can be pointed
at a free pair.

### #193 — no interface change

The page and the contract (`.max(200)`) are untouched. Only the test's
state-setup path and its documented timeout are affected.

## Root cause of #193 (measured)

The test fills 200 controlled inputs, then submits. Each `input` event is a
React *discrete* event, and React flushes discrete events synchronously, so the
test re-renders the 201-row table **once per fill** — 200 full renders, each
with a Base UI `Select` per row.

Measurements (this host, 12 cores):

| Run | fill-200 | whole test |
| --- | --- | --- |
| isolation | ~15 s | ~16 s |
| full `bun run test` (turbo, api+web parallel) | — | 15.4 s |
| isolation + 40 CPU burners (≈3.3× oversubscription) | — | **305 s → fail** |

Scaling probe (`fills` × 201 rows): 20 → 2.5 s, 50 → 5.0 s, 100 → 7.5 s,
200 → 16.5 s — linear in fills, i.e. one render each.

Because the fill loop is synchronous, no per-test timeout can be *safe* on an
arbitrarily contended host: bun cannot pre-empt the sync loop, and a fixed
bound is only a bet on the host's CPU share. The robust fix is therefore to
**remove the 200 renders**, not to raise the bound.

### Chosen fix

Fill the 200 rows through React's own change handler inside a single `act`, so
React batches the 200 state updates into **one** render (~0.1 s measured for the
loop, <1 s for the whole test). The helper:

- sets the input's value with the native setter,
- invokes the element's React `onChange` prop (the page's real handler, so the
  page's own `setRow` is still the code under test),
- falls back to a real `input` DOM event if React's internal props binding is
  absent, so a React upgrade degrades to the slow-but-correct path rather than
  silently doing nothing.

The rest of the file keeps driving real DOM events (`setInput`, `typeIntoRow`),
so event-wiring coverage is unchanged; this one boundary test just stops
re-running React's discrete-event flush 200 times.

### Deliberate timeout, not a bigger one

The test keeps its existing `60_000` budget, now via a named constant with the
rationale inline. After the fix the test costs <1 s of CPU, so 60 s is ~60×
headroom even before considering that the loop no longer does 200 renders — the
bound is a safety net, not the mechanism. The bound is **not increased**.

## Planned tests / evidence

- `#202`:
  - `playwright test tests/e2e/vault.spec.ts` on the default pair (unchanged).
  - Two `playwright test tests/e2e/vault.spec.ts` runs **concurrently** on
    disjoint `DOKAN_PORT`/`DOKAN_WEB_PORT` **and** disjoint
    `DOKAN_VAULT_PORT`/`DOKAN_VAULT_WEB_PORT`; both must pass, proving no
    cross-talk.
  - Negative control: the same concurrent pair sharing the vault ports should
    fail (or at least collide) — documents that the isolation is what makes it
    work. (Optional; the positive proof is the acceptance.)
- `#193`:
  - The focused test under the 40-burner contention that reproduced the failure.
  - Full `bun run test` (turbo) green.
- Both: `bun run typecheck`, `bun run lint`, full `bun run test:e2e`.

## Risks

- **Internals coupling (#193).** `__reactProps$` is a React-internal binding.
  Mitigated by the DOM-event fallback and a comment; if React renames it the
  test stays correct, only slower.
- **Default drift (#202).** If the defaults were wrong, existing runs would move
  ports; they are the current literals, so a run that does not set the new vars
  is byte-for-byte unchanged.
- **AGENTS.md dependency.** The "one lane at a time" warning currently lives
  only on the unmerged PR #199 branch; `origin/develop`'s `AGENTS.md` has no
  lane section. This branch states the post-fix fact, and the warning must not
  be reintroduced when #199 rebases onto it. Flagged in the report.

## Non-goals

- No app, contract, or schema change.
- No fix for a real app bug behind either failure (none found: the vault failure
  was a port collision; the 201 test is a render-cost timeout).
