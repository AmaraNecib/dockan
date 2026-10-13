# Issue 174 — Greptile local review attempt

The `greptile` CLI is installed (v3.6.0), but authentication is not usable from
this lane:

```
$ greptile whoami
error: refresh failed: access_denied
```

No authenticated review was produced, and an interactive `greptile login`
cannot be completed from an autonomous worker lane. `greptile review --json
--branch develop` was not run because auth had already failed.

The parent (which owns the PR and the remote) should run the Greptile review on
the PR, or re-authenticate and run:

```bash
greptile review --json --branch develop
```

No code was sent to Greptile. Local gates are green; see the sibling evidence
files for debate / test-audit / code-review.
