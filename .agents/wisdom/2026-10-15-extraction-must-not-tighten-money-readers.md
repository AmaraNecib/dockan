# A behaviour-preserving extraction must not tighten the readers it moves

**Date:** 2026-10-15 · **Ticket:** 146 · **Area:** apps/web/src/lib/invoice-draft.ts, purchase unit cost

Ticket 146 extracted the shared invoice-draft mechanics out of `sale.tsx` and
`purchase.tsx`. While moving purchase's unit-cost handler, the extraction
replaced `Number(event.target.value)` with the repo's strict `parseWholeNumber`
from `lib/numeric-input.ts`. That looked like an obvious improvement: the file's
own docstring says `Number()` happily accepts `"1e3"` and `"0x10"`.

Both review rounds called it the worst finding on the branch. The brief was
"preserve the money math exactly", and `"1e3"` used to bill 1000 while the strict
reader silently kept the previous cost. Deferring a stricter reader to a real
ticket is the point: a refactor that also changes what a money input bills is not
a refactor, and it hides the change inside a diff nobody reads for its arithmetic.

**Always**: when you move a reader, a validator or a default during an
extraction, port the old predicate literally, including its generous cases, and
pin those cases in a test. If you want the stricter rule, make it its own change
with its own test and its own review. A useful tell in review: the new module
documents a stronger contract than the code it replaced.
