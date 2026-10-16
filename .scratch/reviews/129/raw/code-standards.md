# #129 — Standards review (code-review axis 1)

**HEAD:** ee32c44 · **Base:** a52084d1 · **Scope:** whole diff, delta spot-checked.
Axis: documented standards + baseline smell list. Judgement calls separated from hard violations.

## Delta under specific scrutiny

`tests/e2e/rpc-helpers.spec.ts:77` (`void refusal.catch(() => undefined)` immediately
after arming `page.waitForResponse`). Correct: mirrors the pattern the next test
already uses, and the comment names the failure it prevents (an abandoned wait's
rejection surfacing over the action error). No standards issue. Nothing in the
delta re-opens a settled decision.

## Hard documented-standard violations

None found against AGENTS.md, docs/engineering-workflow.md, unslop/SKILL.md, or
CONTEXT.md. Source-only policy holds: 18 tracked source/test files plus ignored
`.scratch/` evidence; no staged files; no dist/artifacts in the diff. Evidence
filenames carry the reviewed SHA. Lint/types/tests gates have logs for ee32c44.

## Baseline smells (judgement calls only, none blocking)

- **Duplicated Code** — `rpc-helpers.ts:135` and `rpc-helpers.ts:181`: the same
  envelope guard (`body === null || !hasOwnProperty(body,"json")` → throw) and the
  same SAFETY comment appear in `rpcOutput` and `readRpc`. Extractable to one
  helper; two call sites is below the usual threshold, so trim only if touched again.
- **Middle Man** (mild) — `readEnvelope` (`rpc-helpers.ts:33`) only wraps
  `rpcOutput` in `.then`. It earns its name (the eager-read behaviour is the point)
  and documents why, so this is acceptable rather than a defect.
- **Repeated condition / Duplicated Code** — `party-forms.tsx:78` and `:90`
  repeat `party === undefined || party === null`. Pre-existing pattern in this
  file (also in `onSuccess`); not introduced here.
- **Speculative Generality** (mild) — `i18n.ts:984` `SERVER_ERROR_ALIASES` is a
  `Map` holding one entry. The design doc justifies the map as the alias seam, so
  it is a deliberate call, not accidental generality.
- **Duplicated guard** (mild) — `party-picker.tsx:155` re-checks `phoneInvalid`
  in the create handler though `createDisabled` already blocks Save. Defensive
  mirror of the existing `phoneOwner` guard; consistent with the file.

## Style / unslop

New docblocks use em dashes (`phone.ts:70-88`, `rpc-helpers.ts:105`). unslop rule
13 discourages em dashes, but the repo baseline uses them pervasively (pre-existing
`rpc-helpers.ts` and `drizzle-store.ts` comments), so repo standard overrides: not
flagged. Comments are otherwise concrete, name mechanisms, and avoid filler.

## Verdict

Ship. No blockers, no fixes required. All findings are judgement calls already
consistent with the surrounding code.
