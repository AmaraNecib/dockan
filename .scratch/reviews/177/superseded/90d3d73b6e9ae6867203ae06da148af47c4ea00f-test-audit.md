# Test-audit evidence — #177/#180, Greptile round-3 delta

- Base: `8259667` · prior reviewed head `43dc30d`
- Reviewed head: `90d3d73b6e9ae6867203ae06da148af47c4ea00f`
  (final code head `11498e4`)
- Tier: High-assurance
- Edge-case/coverage + quality reviewers ran across the round-3 iterations.

## Pre-fix-failing tests (verified by reverting the source)

Web (`supplier-opening-balance.test.tsx`, all fail at `43dc30d`):
- "forwards confirmExisting on a named row in a mixed confirmed batch";
- "refreshes suppliers after a confirmed refusal too";
- "does not overwrite an invalid target draft when adopting a typed name";
- "counts a resolved typed name toward the batch limit and blocks before the server".

API (`router.test.ts`, both fail without the server fix):
- "keeps a named-batch retry on the original account when both fold to one name";
- "keeps a supplierId retry on the signature-holding sibling" (fails against the
  intermediate `c955ee2`, confirming the critic's bypass is genuinely pinned).

Finding 5 is comment-only and not testable.

## Coverage notes

- Each fix has a targeted test; the API retry tests assert the post-state on **both**
  accounts (original keeps exactly one 700; the sibling has zero), so they catch both
  "no throw" and "wrong target".
- The 201-row limit test needs a 60s timeout (~16s run); a smaller injected cap would
  be lighter, but the cap is a module constant.

## Dismissed / accepted

- The `(Greptile round N)` test-name suffix is traceability noise, consistent with the
  file's convention.
- The 201-row test is the most expensive test in the file; accepted for the cap
  boundary coverage.

## Verification at head

- Web `bun test`: 842 pass / 0 fail.
- API `bun test`: 816 pass / 0 fail.
- `bun run test:e2e`: 53 pass / 0 fail.
