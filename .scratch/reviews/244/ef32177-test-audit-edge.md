# Edge-case audit — ef32177 (#244 round 4)

Method: read the diff, scanner, tests, design + brief; ran the round-4 fixtures against the
real scanner and two mutated copies (temp dir outside the repo; repo untouched). No suite run.

## Correct (verified, not assumed)

**The two fixtures the task questioned both discriminate — empirically confirmed.**

| fixture | orig | mutated scanner | verdict |
| --- | --- | --- | --- |
| `privateField` (`blankness-ratchet.test.ts:604`) | `this.#draft.trim() === ""` | `#` made a word char → `draft.trim() === ""` | fixture FAILS ⇒ pins the `#` exclusion |
| `insideChain` (`:587`) | `trimmed === "" [draft.trim()]` | always-a-space → `[]` | fixture FAILS ⇒ pins the conditional separator |

- `privateField`: with `#` a word char the separator emits `this.# draft`, `CHAIN` stops at `this.#`,
  and the match re-anchors on `draft` — a wrong receiver. Test catches it. Good.
- `insideChain`: only the two-step path is hurt by an unconditional space (`DECL_TRIM` is a bare
  `\.trim\(\)`, no `\s*`); inline matchers tolerate whitespace, so the fix's narrowness is right.
- Two comments in a row: `const/*a*//*b*/trimmed` → no space at the first close (`/` isn't a word
  char), space at the second ⇒ `const trimmed`, gate caught in **all** three variants. No gap.
- `$` fusion: `const/*c*/$x = draft.trim()` ⇒ `$x === "" [draft.trim()]`. Correct.
- Space insertion shifts `out.length`, but `opens`/`braces` are recorded in the same `out` coords in
  the same pass, and the space has no `\n`, so scopes and `lineAt` stay consistent.

**No vacuous tests.** `ratchet-first-red.log` shows all three round-4 tests red on the pre-fix
scanner (`- [gate] + []`), so each new `toEqual([gate])` can fail. The `wholeValue`/`stringArgument`
sub-cases are precision pins, not discriminators for finding 1 — and they are real: `stringArgument`
(`:571`) fails if `normalisesWholeValue` drops its quote-skip (a flat scanner stops at the `)` inside
`replace(")", "")` and reports a false gate).

## Note — the `>127` branch is a dead, untested branch that masks a real leak

`blankness-gates.ts:131`
```ts
const isWordCharacter = (char: string) => /[\w$]/.test(char) || char.charCodeAt(0) > 127;
```
No round-4 fixture (and no existing fixture) exercises the `>127` arm. I could not construct any
input where it changes output, because every downstream name pattern is ASCII-only:
`DECL` name `[A-Za-z_$][\w$]*`, `CHAIN` `[A-Za-z_$#][\w$]*`, `USE_*` `[A-Za-z_$][\w$]*`. So the
branch is inert — while the shape it was written for still leaks:
```ts
// const dé = draft.trim(); if (dé === "") ...   →  findBlanknessGates ⇒ []
```
Confirmed on all three variants: a non-ASCII bind name makes `DECL` miss the declaration, so the
two-step gate escapes (unsafe direction; pre-existing, not introduced by this diff).
Pin (fails today, documents the leak or forces the branch to be deleted):
```ts
const nonAscii = [
  "export function f(draft: string) {",
  "  const trim\u00e9d = draft.trim();",
  '  if (trim\u00e9d === "") return null;',
  "  return trim\u00e9d;",
].join("\n");
expect(findBlanknessGates(nonAscii, "synthetic.ts").map((g) => g.signature)).toEqual([
  "synthetic.ts::trim\u00e9d === \"\" [draft.trim()]",
]);
```

## Note — digits, over-insertion: no gap found

`isWordCharacter` includes digits, but `id/*c*/id` and `1/*c*/e3` are not valid JS, and I found no
input where either a digit boundary or an over-inserted space creates or hides a gate.

## Note — documented ceilings still hold

Regex literals, non-ASCII identifiers, flat-quote `normalisesWholeValue` and `[...]`-in-string
`withoutSubscripts` remain as the KNOWN CEILING comment states; no new leak was introduced by the
three fixes.
