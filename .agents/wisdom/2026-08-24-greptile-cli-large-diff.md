# Greptile CLI fails on large branch diffs; use the PR path

**Date:** 2026-08-24 · **Ticket:** 28

`greptile review --json --branch develop` rejects with "review is too large to
send" when the branch carries bulky non-source commits (e.g. vendored skill/docs
markdown shared across feature branches). The hosted path still works:
comment `@greptile-apps review` on the PR, then poll:

```bash
gh api repos/<org>/<repo>/pulls/<n>/reviews --jq 'length'   # review lands here
gh pr view <n> --json statusCheckRollup                      # Greptile Review check
```

Notes: the bot posts the summary as an issue comment and inline findings as PR
review comments; the review object body can be empty — read the comments. First
response took ~10 min; re-review after fixes another ~10. Trigger re-reviews by
commenting `@greptile-apps review` again with the fix commit SHA in the message.
