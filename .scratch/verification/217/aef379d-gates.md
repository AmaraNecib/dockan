# #217 gate evidence — reviewed HEAD `aef379d`

Branch: `fix-217-vault-single-failure`. Base: `e71b2b1` (origin/develop).
Tier: High-assurance. Run from `apps/web` where noted, else from the repo root.

## Guard Phase 1 / 2 (local)

| Command | Exit | Note |
|---------|------|------|
| `bun install` | 0 | 189 packages |
| `bun run typecheck` | 0 | turbo, 4/4 tasks |
| `bun run lint` | 0 | oxlint, no findings |
| `bun run test` | 0 | turbo, 4/4 tasks |
| `cd apps/web && bun test src/components/vault/vault-gate.test.tsx` | 0 | 21 pass / 0 fail, 95 assertions |

## E2E (vault flows)

```
DOKAN_PORT=4800 DOKAN_WEB_PORT=5800 DOKAN_VAULT_PORT=4801 DOKAN_VAULT_WEB_PORT=5801 \
E2E_DATA_DIR="$PWD/.e2e-data/fix-217" \
bun run test:e2e --output=.e2e-data/fix-217/test-results tests/e2e/vault.spec.ts
```

- Slot: `e2e-slot.sh acquire fix-217 --no-wait` → `PORT_SLOT=slot2`; released in the
  same command (`e2e-slot.sh release fix-217` → `released slot2`).
- Result: **4 passed (2.4m)**, exit 0. Log: `.scratch/verification/217/e2e-vault.log`.
- `tests/e2e/vault.spec.ts` is unchanged between the e2e run (`6528d3d`) and
  `aef379d`; the only delta is unit tests and docs, so the run stands. The
  production file `apps/web/src/components/vault/vault-gate.tsx` is byte-identical
  across `6528d3d`, `63cd623` and `aef379d`.

## Discriminating-test proof (re-run at `aef379d`)

`bash`: base component `e71b2b1` + `mutation-core.patch`, HEAD test file.

```
Expected: "false"
Received: "true"
  at vault-gate.test.tsx:241:52
(fail) ... a failing recovery action never keeps the empty-passphrase blame ...
20 pass / 1 fail
```

Full ablation table and the honest chain-level scope: `mutation-proof.md`.
Log: `aef379d-mutation-core.txt`.

## Guard Phase 2

- Working tree clean at `aef379d` (source + tests + evidence committed).
- Review evidence: `../reviews/217/aef379d-debate.md`, `aef379d-test-audit.md`,
  `aef379d-code-review.md` — all three, exact reviewed SHA.
