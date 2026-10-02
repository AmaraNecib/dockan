# Re-review fixes — PR #117 (round-6 findings on ccfd747, 2 findings)

- Tier: High-assurance. Fixed head: `0a0537c` (round 6, on top of `ccfd747`).
- Both findings fixed; parser verified shape-by-shape against Bun.

## 1. Unmatched opening quote (secrets.ts:89-93)

Bun 1.4 behavior, confirmed with `bun -e` probes:

| File | Bun value |
|---|---|
| `A="unterminated` (EOF, no closer anywhere) | `"unterminated` (opening quote KEPT) |
| `A='unterminated` | `'unterminated` |
| `A="unterminated # note` | `"unterminated` (comment stripped, quote kept) |
| `A="unterminated\nB=next\n` | `A="unterminated`, `B=next` (following lines parse) |
| `A="unterminated\nB="closer"\n` | `A=unterminated\nB=` (spans lines to the later closer; B not parsed) |
| `A="quoted" # note` | `quoted` |

`parseEnvValueFrom` now implements exactly that: it scans the current line and
then subsequent lines for a closer (with `\"` escapes inside double quotes);
when one exists, the value is everything between (joined with `\n`) and the
rest of the closing line is ignored; when none exists, the rest of the line is
kept with the opening quote and an inline comment stripped, and parsing
continues on the next line.

A parity script compared our parser with `bun -e` on all six shapes: **all
MATCH**. Tests: parser cases for the unmatched shapes and the multi-line closer,
plus an inherited-value test where an ambient file holds
`DOKAN_BUILD_SECRET="unterminated-secret-0123456` and the slugged build ignores
it (generates instead). End-to-end: a repo-root `.env` with the unmatched quote
was ignored by `DOKAN_CUSTOMER_SLUG=acme bun run desktop:sidecar`, which kept
the `.env.acme` stamp `99e04e6d8e03d510`.

## 2. Inherited empty value blocked the release (secrets.ts:276-278)

`resolveOne` now computes `inherited = fromAmbientFile || (!envIsExplicit &&
fromBaseFile)` before the empty check. An inherited empty value falls through to
the target `.env.<slug>`; only a genuine explicit empty override (no ambient or
base match) is rejected with `not set — refusing to ship a default secret`.

Tests:
- in-process: ambient `DOKAN_AUTH_SECRET=`, explicit empty, a valid `.env.acme`
  → the customer value is used and nothing is generated;
- spawned child with a repo-root `.env` containing the empty value,
  `BUN_OPTIONS=--no-env-file` and the inherited empty in its environment → the
  `.env.acme` value is used.

End-to-end: a repo-root `.env` with `DOKAN_AUTH_SECRET=` did not block
`DOKAN_CUSTOMER_SLUG=acme bun run desktop:sidecar`; the acme auth stamp stayed
`60b910fc6f3ec493`. The existing explicit-empty rejection test still passes.

## Gates on the final HEAD

| Gate | Result |
|---|---|
| `bun run typecheck` | exit 0 |
| `bun run lint` | exit 0 |
| `bun run test` | exit 0 |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | 13 + 12 passed |
| `cargo clippy … --lib -- -D warnings` | exit 0 |
| `cargo clippy … --all-targets -- -D warnings` | exit 0 |
| `cargo clippy …/sidecar-freshness/Cargo.toml --all-targets -- -D warnings` | exit 0 |
| build.rs policy checks (acme reuse, rotated secret, bare slug, unscoped over customer stamp, torn binary, restages) | all as expected |

## Residual risks

- The parser's multi-line quote handling joins with `\n`; a CRLF file could
  still differ from Bun's exact bytes for a multi-line value. Such files are
  hand-written and malformed for secrets.
- An explicit empty override that happens to equal an ambient/base empty value
  is treated as inherited and does not fail; the safe direction (never block a
  valid customer file).
