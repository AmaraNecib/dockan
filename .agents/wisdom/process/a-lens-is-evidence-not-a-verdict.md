# A review lens is evidence, not a verdict: verify its blocking finding before you act on it

**Date:** 2026-10-18 · **Ticket:** 276 · **Area:** review pipeline — `debate`, `test-audit`, `code-review`

Three lenses ran on PR #285's head (`b4a8e80`, the rebased tip; the api fix they disputed landed
in `375788b`). Two were useful. The third filed a HIGH blocker with
a score that was wrong in the same direction as its diagnosis:

> *"the diff has no `apps/api` change... nothing on the status route ever delivers the code, in
> develop, in the #275 branch, or at this head"* — filed alongside **Spec 4/10, Standards 5/10**

The claim was false. The refusal app registers the JSON route **before** the catch-all:

```ts
534: app.get("/health",           (c) => c.json({ ok: false, error: "VAULT_LOCKED_BY_OTHER_INSTANCE" }, 503));
537: app.get("/api/vault/status", (c) => c.json({ error: { code: "VAULT_LOCKED_BY_OTHER_INSTANCE" } }, 503));
538: app.all("*",                 (c) => c.html(vaultLockRefusalPageHtml(error.owner), 503));
```

Hono matches in registration order, so line 537 answers `/api/vault/status`. The lens read line 538
and concluded nothing else was registered. Acting on it would have meant discarding working code
that CI proved correct eight minutes later (`playwright e2e pass, 8m13s`).

**The rule:** a lens's finding is a claim about the tree, and every load-bearing claim is checkable
with one grep. Do the grep before the fix, and before repeating the finding to anyone.

```bash
git show <head>:apps/api/src/lib/vault/lock.ts | grep -n "api/vault/status\|app.all"
```

**Why a scored lens is the dangerous kind.** A lens that says "I could not verify X" is usable. A
lens that says "Spec 4/10" *and* is wrong reads as measured, so the score transfers confidence to
the error. Treat the score as unvalidated whenever the headline finding is.

**How to spot the class:** the lens read one registration and reasoned about the whole surface. The
same shape appears in any framework with a fallback (route catch-alls, default cases, `??`
fallbacks, middleware order). Ask "what is registered before the fallback that I have not read?"

**What the other two lenses did right, in the same round:**

- **debate** found a real merge-order defect from source, before CI agreed with it.
- **test-audit** ablated every assertion (reverted the fix, re-ran, counted failures) and reported
  which tests pinned behaviour. That is the evidence a lens can actually produce.

**Corollary on my own error, same round:** I grepped for the code-review finding's quoted comment
with `grep -rn "names a cause"` and got nothing, so I nearly published that the lens had invented
the quote. The phrase was real at `App.tsx:55`; it wrapped across a line break inside a `//` block.
Grepping for a quote with a line break in it proves nothing. Grep for a short distinctive fragment,
or read the file.
