# #259 — test-audit evidence (Standard tier)

Head reviewed: `6a97cd67db1326b4e7b5d5f88910e1bb9b21afa9` (final). Rounds 1 and 2 ran against
`d9d07cf` and `ab163de`; the round-2 minors are applied in `6a97cd6`, which only tightens prose and
widens the link regex — the guard was re-run green at this head.

Lens: two independent read-only `reviewer` children (test-audit and Standards/Spec code-review). This
file is the test-audit result. Verdict: **no blockers**.

## What was checked

1. Vacuousness — can the suite pass while the rule is absent or wrong?
2. Edge cases — missing doc, empty doc, bare mention, broken link target, CRLF.
3. Brittleness — do the pinned fragments redden on a rewording that keeps the rule?
4. CI wiring — does `scripts/*.test.ts` actually run, and is it path-gated for a docs diff?
5. Shallow/missing tests for a docs change under Standard tier.

## Round-1 findings and their fix

- **Major — the link check was a substring.** `toContain("verification-and-merge-gate.md")` passed a
  bare mention and a link to a missing file. Measured on `d9d07cf`: delete the doc → the three link
  cases still passed (3 pass / 8 fail). Fixed in `ab163de`: `linksToDoc` parses `](...)` and
  `existsSync`-resolves the target. Ablation D (`AGENTS.md` link → code span) now reddens exactly the
  one link case (19 pass / 1 fail).
- **Major — reason 4's head clause, cardinality and AUTO/OWNER association unpinned.** Fixed: added
  fragments for "equals the current head SHA", "at the head being merged", "hold. Not three", and a
  row-association case. Ablation E (strip the AUTO row's class cell) reddens two cases (18 pass /
  2 fail).
- **Minor — sentence-level fragments (`**and**`, an embedded backtick).** Fragments are now fact-level
  and single-line (CRLF-safe). Round 2 still notes the guard reddens on some rewordings that keep the
  rule; that is accepted friction, recorded below.
- **Minor — `doc.length > 500` is a smoke test.** Kept deliberately: it catches an emptied file; the
  fragment cases carry the rule.

## Round-2 notes (accepted, not changed)

- Fragments are still exact-phrase, so a legitimate reword (e.g. "video at real user pace" →
  "a clip at real user pace", already used in `docs/engineering-workflow.md`) reddens the guard. The
  alternative is a semantic checker far larger than the rule it guards. The failure is loud and
  names the fragment, which is the right direction for a discoverability guard.
- `<!-- crew-evidence -->` appears twice in the doc; a rewrite of reason 3 alone stays green via the
  §1 occurrence. The marker is still pinned in the tree, which is what "carries the marker" means.
- The row test pins the class substrings, not the row body. Intentional scope.

## CI wiring (verified)

`package.json:21` → `"test": "turbo test --concurrency=2 && bun test ./scripts/"`. The `checks` job in
`.github/workflows/ci.yml` has no `needs: changes` and no path gate; only `e2e` and `rust` read
`scripts/e2e-selection.ts` output. A docs-only diff still runs `bun test ./scripts/`.

## Commands

```sh
bun test ./scripts/verification-rule.test.ts   # 20 pass / 0 fail, exit 0 at 6a97cd6
bun test ./scripts/verification-rule.test.ts ./scripts/e2e-selection.test.ts ./scripts/sync-claude-skills.test.ts
                                               # 84 pass / 1 skip (pre-existing Windows symlink) / 0 fail
```
