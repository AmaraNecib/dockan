# #249 code-review (Standards + Spec) — independent sub-agent at `353089e`

Raw artifact: `.pi/.../subagent-artifacts/295c36e0-..._reviewer_output.md`.
Fix commit: `53ed964`.

## Standards

Docs checked: `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`),
`docs/engineering-workflow.md`, `AGENTS.md`, `oxlint.config.ts`. **No documented
rule violated** (`oxlint`, `tsc`, skills:check all green). Findings are
Fowler-baseline judgement calls:

- **Duplicated Code** — `unwrap` and `transparentParent` are two loops stripping
  the same five wrapper kinds. *Deferred: readability only; merging them would
  obscure the "value-preserving wrapper" intent at each call site.*
- **Long Function** — `findBlanknessGates` holds the whole classifier. *Deferred:
  the closure works on shared `declarations`/`bySignature`; extraction is a
  refactor, not a fix.*
- **Repeated Switches** — the `classifyTrimUse`/`refuseIfTestPosition` dispatch
  chain. *This is where the fixed blocker lived; the new `.length` branch is now
  pinned by the 14-branch deletion proof.*
- **Speculative Generality / Primitive Obsession (weak)** — `SatisfiesExpression`
  handling and `blankKind`. *Kept: fail-closed robustness.*

## Spec

Against `issue-249-ast-walk.md` and `249-design.md`.

- **Worst — fail-closed gap (high).** `if (x.trim().length)`,
  `while (x.trim().length) {}`, `x.trim().length ? a : b`, `!x.trim().length` and
  two-step `if (t.length)` returned `[]` with no throw: `classifyTrimUse` returned
  early on a `.length` access, but the comparison walk only owns the relational
  and `=== 0` forms. Semantically `x.trim().length` truthiness is `!== 0` — a
  blankness gate. **Fixed at `53ed964`** with red-first fixtures.
- **Undocumented fixture change (partial).** The private-field fixture source was
  edited because `this.#/* gap */draft` is invalid TS. **Documented in
  `249-design.md` ("Fixture deviation"):** same receiver, same signature, valid
  syntax; every other `#244` fixture is byte-identical.
- **Parser recovery unchecked (note).** `sourceFile.parseDiagnostics` is not
  inspected, so a syntactically broken file can be mis-attributed rather than
  refused. **Stated ceiling** in the module header and design doc; production
  files parse clean.

Interface seam verified intact: `findBlanknessGates`, `BlanknessGate`,
`numericReaderFiles` (unmodified hunk), signatures unchanged; `bun test
src/lib/blankness-ratchet.test.ts` → 52 pass / 0 fail at `53ed964`.

## Summary

- **Standards:** 4 judgement findings, 0 documented-rule violations; worst: Long
  Function `findBlanknessGates` (deferred).
- **Spec:** 3 findings (1 high fixed, 2 notes documented); worst: the fail-closed
  `.length` truthiness gap, **fixed**.
