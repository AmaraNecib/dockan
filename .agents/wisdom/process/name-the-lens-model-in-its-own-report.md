# Name the reviewer model in the report, on its own line

**Area:** process — review lenses, evidence

A lens report is evidence, and evidence says who produced it. #282's code-review report opened with
`Read-only reviewer (zen-proxy/deepseek-v4.1-flash-free family, author-owned for fixing)`, which names
the *author's* model inside a sentence about the reviewer. Greptile read it as the reviewer and filed a
P2 asking for the lens to be re-run on the required model. The lens may well have run on the right
model; the report made that impossible to tell, and an unverifiable claim is a defect on its own.

Every lens report carries these two lines right under its title, and nothing sits between them:

```
Reviewer model: opencode-go/glm-5.3-flash
Author model:   opencode-go/deepseek-v4.1-flash
```

The model IDs above are the pair in force from 2026-10-19, when OpenCode's free tier began refusing
this box's IP and the `zen-proxy/deepseek-v4.1-flash-free` / `zen-proxy/glm-5.3-flash-free` pair became
unusable. The rule is the pair, not those two strings: name whichever reviewer and author models
actually ran, and correct the pair here when it moves again.

Why it matters past tidiness: the reason the reviewer is a second model is that the author's blind
spots are not the reviewer's. If the report does not name the reviewer, the gate cannot check that
separation, and the next reader has to take it on trust — which is the failure a second model exists to
prevent.

**A harness a PR commits is evidence too, and it has to run for the next reader.** #285's
`capture.mjs` rewrote a file it had just made tracked and then asserted a clean `git status`, so its
own log read as a tracked change and the re-run failed on a clean checkout. Anything that asserts
cleanliness excludes its own artifacts, and evidence tooling is proven by re-running it, not by having
worked once.

**Media and its harness do not go in the reviewable diff.** `develop` tracks 794 files under
`.scratch/reviews/` and 105 under `.scratch/implementation/`, and **zero** under `.scratch/evidence/`.
Images, GIFs and mp4s are hosted on R2 — the layout is in #263: `<PR>/before/`, `<PR>/after/`, and the
Full HD pair under `<PR>/after/hd/`. A capture harness stays local until another person needs it.
#285 committed both, which is how a dev tool carrying a `git status` assertion ended up inside a code
review for a web fix and earned the P2 above. The media is the evidence; the tooling is a convenience
that has to earn its place, and the default is that it does not.

**Seen in:** #282 (code-review header, Greptile P2), #285 (`capture.mjs:157`, Greptile P2).
