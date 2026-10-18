# Name the reviewer model in the report, on its own line

**Area:** process — review lenses, evidence

A lens report is evidence, and evidence says who produced it. #282's code-review report opened with
`Read-only reviewer (zen-proxy/deepseek-v4.1-flash-free family, author-owned for fixing)`, which names
the *author's* model inside a sentence about the reviewer. Greptile read it as the reviewer and filed a
P2 asking for the lens to be re-run on the required model. The lens may well have run on the right
model; the report made that impossible to tell, and an unverifiable claim is a defect on its own.

Every lens report carries these two lines right under its title, and nothing sits between them:

```
Reviewer model: zen-proxy/glm-5.3-flash-free
Author model:   zen-proxy/deepseek-v4.1-flash-free
```

Why it matters past tidiness: the reason the reviewer is a second model is that the author's blind
spots are not the reviewer's. If the report does not name the reviewer, the gate cannot check that
separation, and the next reader has to take it on trust — which is the failure a second model exists to
prevent.

**A harness a PR commits is evidence too, and it has to run for the next reader.** #285's
`capture.mjs` rewrote a file it had just made tracked and then asserted a clean `git status`, so its
own log read as a tracked change and the re-run failed on a clean checkout. Anything that asserts
cleanliness excludes its own artifacts, and evidence tooling is proven by re-running it, not by having
worked once.

**Seen in:** #282 (code-review header, Greptile P2), #285 (`capture.mjs:157`, Greptile P2).
