# Issue 196 — Greptile CLI (local) attempt

- Attempted HEAD: `338eb5b1b0ee74466d48aff85f5d1a44e0352ed1`
- Reviewed source SHA: `e2d40c91fae892092f3974c00dc4a8b634ee6b1c`
- Base pinned: `f75721133f25bfe29766266381893520e48d6bb0`

## Result: blocked by CLI authentication, not by the change

```
$ greptile whoami
error: refresh failed: access_denied

$ greptile review --json --branch f75721133f25bfe29766266381893520e48d6bb0
error: refresh failed: access_denied          # exit 1

$ greptile review --json --agent --branch f757211...
error: refresh failed: access_denied          # exit 1
```

`~/.greptile/auth.json` exists but its OAuth refresh is denied. `greptile login`
is interactive (browser OAuth, or `--api-key` read from stdin); this lane has no
TTY and no API key, so it cannot re-authenticate. No review was produced.

## Note on `--branch develop`

The first attempt used the unqualified local `develop`, which in this worktree is
stale (`8579fcf`, far behind `origin/develop` `f757211`), so the CLI saw a huge
diff and refused with `error: this review is too large to send`. Pin the base to
the merge-base SHA (`--branch f757211...`) as done above; see
`.agents/wisdom/2026-08-24-greptile-cli-large-diff.md`.

## Next action (parent owns landing)

Re-authenticate (`greptile login`) or set an API key, then:

```
greptile review --json --branch f75721133f25bfe29766266381893520e48d6bb0
```

The local gates are all green: typecheck, lint, 958 unit tests, and the full
Playwright suite (57 passed) on isolated ports. See `e2d40c9-verification.md`.
