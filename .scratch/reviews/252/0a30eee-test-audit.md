# #252 — test audit

Reviewed lane HEAD: **0a30eee**. Three lenses (edge-case hunter, coverage analyst,
quality reviewer) ran as separate read-only sub-agents in rounds 2 and 3; the final
round was a combined lens. Every finding classified "Fix it" is applied; the
residual notes are listed with severity and disposition.

## Acceptance coverage at `0a30eee`

| criterion | test that reddens on revert | mutation |
| --- | --- | --- |
| 1. each label on the value its own hint describes | `lib/supplier-entry-display.test.ts` (label-to-VALUE + hint pairing + sign) | M1, M2, M5, M9 |
| 2. WE_OWE → «يسالنا», THEY_OWE → «نسالوه», and picking one submits it | `pages/supplier-opening-balance.test.tsx` (both directions, trigger label + popup order + submit), `components/parties/supplier-adjust-panel.test.tsx` (button label vs title, both submit paths), `pages/debts.test.tsx` (per-row label + sign + date) | M1, M10, M13, M16 |
| 3. no `Select` can render a raw enum value as its label | `lib/select-trigger-label.test.ts` (TS-AST guard over every non-test `.tsx`) | M3, M4, M6, M7, M11, M12, M14, M15 |

Layers: static AST source scan, pure unit on the shipped i18n map, jsdom
render+click, and Playwright e2e (`tests/e2e/supplier-adjustment.spec.ts`). Not one
pattern, and the guard is complementary to (not a duplicate of) the DOM tests: the
guard is the structural barrier for every `Select`, the DOM tests pin the rendered
label for the changed ones.

`bun .scratch/reviews/252/mutation-proof.ts` exit 0 at `0a30eee`: 16 mutations, all
redden a named test, all five mutated files restored byte-identical (sha256 check in
the script). The script is a gate now: it exits non-zero on a missing anchor, a
mutation that does not redden, or a failed restore, and restores in `finally`.

## Findings and dispositions

Round 2 (three lenses), all fixed in `4458560`:
- 🟠 `items={[]}` / `items={undefined}` passed the guard and would render the raw
  value → guard now rejects statically empty maps. M7.
- 🟠 A nested `<Select>` root was blamed for the nested root's `SelectValue` →
  the walk skips a nested root's subtree; shape test case added.
- 🟠 The tree scan could pass vacuously → positive control on trigger-bearing roots.
- 🟠 The «يسالنا» panel button's `onClick` was unpinned → new test starts on
  THEY_OWE and requires the submit `WE_OWE`. M13.
- 🟡 `debts.test.tsx` asserted by position in two independently-queried lists →
  each row is now pinned by its own date, and the label is paired with its own
  row's sign.
- 🟡 `walkTsx` duplicated from `cell-ltr.test.ts` → extracted to
  `tests/source-scan.ts`, one file set for both guards.
- 🟡 The mutation script was evidence, not a gate → see above.

Round 3 (three lenses), all fixed in `0a30eee`:
- 🟠 `items={[] as const}` / `items={EMPTY}` / `items={(undefined)}` still escaped →
  expressions are unwrapped, and a file-local `const EMPTY = []` is resolved. M11.
- 🟡 A map that labels a value with the raw value
  (`items={[{ value: "WE_OWE", label: "WE_OWE" }]}`) passed → rejected, quoted keys
  included. M12, M15.
- 🟡 The positive-control floor counted roots without a `SelectValue` → counts
  trigger-bearing roots (27 at `0a30eee`), floor 10, and M14 proves it is
  load-bearing.
- 🟡 Acceptance 2's WE_OWE submit half was pinned only on the adjust panel →
  a new bulk-screen test selects «يسالنا» after moving the row off the default.

Residual notes, deliberately not changed (all low, all disclosed):
- The empty-array binding lookup is file-wide, not scope-aware — a false positive,
  never a false negative; stated in the guard's docblock.
- The guard cannot see an aliased import, a namespaced tag (`<Select.Root>`), a
  `createElement` root, a wrapper-rendered trigger, or a non-literal map. Stated
  in the docblock; needs symbol resolution the scanner does not do.
- `items={{}}` has no dedicated mutation (every other shape does); covered by
  analogy with M7/M12.
- `directionItems` is rebuilt per render (two objects, no memo).

No test was left passing for the wrong reason: the "both strings appear somewhere"
assertion on the debts table — which passed with the labels swapped — is replaced by
the per-row pin, and that replacement is one of the tests M1 reddens.
