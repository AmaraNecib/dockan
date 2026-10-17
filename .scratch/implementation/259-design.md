# #259 design — the verification rule and the four-part merge gate, written down

Tier: **Standard**. Docs-only (`docs/**`, `AGENTS.md`, `.agents/skills/feature-implement/SKILL.md`,
`scripts/*.test.ts`). Nothing here can reach the product, so none of the five High-assurance failure modes
(stock < 0, payment > total, debt direction, auth bypass, backup corruption) applies. The added test is a
consistency guard, not a product path.

Base: `origin/develop` at `d84356633235d6fef925cee3ac0782d426a9d666` (merge-base = HEAD).

## Problem

Two owner rules live in the harness, not in tracked source: the **verification rule** (evidence form
depends on whether the change is visual) and the **four-part merge gate** (5/5 + reviewed-SHA == head +
no comments after the verdict except pinned evidence + an evidence comment at head). `AGENTS.md` states
the merge bar loosely ("5/5 with no findings and every check green"); `docs/engineering-workflow.md`
states it as "5/5 + checks green". Neither names the reviewed-SHA anchor, the comments-after rule, the
`<!-- crew-evidence -->` marker, or the visual-vs-measured evidence split. The scripts that encode the
rule (`crew-mergeable.ts`, `crew-admit.ts`, `crew-queue.sh`) live under untracked `.scratch/scripts/`, so
the rule is discoverable only by someone who already knows where to look.

## Deliverable

1. `docs/verification-and-merge-gate.md` — the canonical rule: verification (visual vs measured), the
   four reasons, the AUTO/OWNER/REFUSED decision, and the queue-when-it-cannot-merge path.
2. Reference it from the three tracked files a lane reads: `docs/engineering-workflow.md` (review
   invariants + merge rules), `AGENTS.md` (Merging), and `.agents/skills/feature-implement/SKILL.md`
   (step 11 + merge rules).
3. `scripts/verification-rule.test.ts` — the discoverability guard. Fails if the doc is deleted, if any
   of the three lanes stops linking it, or if the doc drops one of the four reasons / the evidence marker.

## Interfaces

- No runtime API. The test reads `docs/verification-and-merge-gate.md`, `docs/engineering-workflow.md`,
  `AGENTS.md`, `.agents/skills/feature-implement/SKILL.md` from the repo root and asserts on their text.
- The doc names the scripts by path but does **not** require them to exist: they are harness-local
  (`.scratch/**`, untracked) and absent in CI. The test therefore asserts only on tracked files.

## Planned tests

- `bun test ./scripts/verification-rule.test.ts` (also reached by `bun run test`, which appends
  `bun test ./scripts/` after `turbo test`).
- Cases: doc exists + non-empty; each of the three lane files links to it; the doc carries the four
  reasons, the `<!-- crew-evidence -->` marker, the reviewed-SHA==head rule, and both evidence forms.
- Ablation: delete the canonical doc and confirm the guard reddens; revert a link and confirm the guard
  reddens. Record both with command + exit code.

## Risks

- **Brittle prose test.** A guard that pins four prose sentences would break on a rewording that keeps the
  rule. Keep the pinned strings to the load-bearing literals (the marker, `5/5`, `Last reviewed commit`,
  the two evidence-form headings) and let prose change around them.
- **Claiming more than the predicate does.** `crew-mergeable.ts` hard-refuses reasons 1–3 plus CI and
  conflict; it does not verify that an evidence comment exists. The doc says exactly that instead of
  claiming all four are scripted.
- **Untracked scripts.** The doc points at `.scratch/scripts/`; a reader in a fresh clone will not find
  them. Say they are harness-local so the doc does not read as a broken link.
