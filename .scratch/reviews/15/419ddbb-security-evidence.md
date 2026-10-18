# Security-fix evidence — PR #51 TOCTOU round — HEAD 419ddbb

- Branch: `feat/15-desktop-packaging`. Base SHA `9e4e97b`. Head SHA `419ddbb`.
- Prior round (findings 1–3 incl. verified discovery): `.scratch/reviews/15/bbfc84d-security-evidence.md`.
  This file covers the follow-up finding (free-port probe TOCTOU) and the
  re-keyed head for the whole PR #51 security series.

## Finding — free-port probe TOCTOU (fixed)

**Vulnerability:** the first fix probed ports (`find_free_port`) and spawned
the child afterward. A local process binding the eventual port in between
receives the boot token in the health-check URL, echoes it in a 200, passes
verification, and the webview would load attacker-controlled HTML.

**Fix — no probe, kernel-assigned reserved port:**
1. `reserve_port()` binds a `TcpListener` on `127.0.0.1:0`. The kernel assigns
   a truly free port and the listening socket holds it **exclusively** while
   the child is spawned (no probe → no predictable port → no race to it).
2. The exact port is passed via `DOKAN_PORT` (authoritative for the api: it
   binds that port or exits loudly).
3. The reservation is dropped only after the spawn; ownership is then proven
   **twice** before navigating, never by the persistent record alone:
   - token echo: `GET /health-token?token=…` must return 200 with the exact
     `"token":"…"` JSON field (constant-time compare, one-time getrandom
     token — unchanged from before);
   - registry ownership: `.dokan-port.registry/<child-pid>` must record
     exactly that port (`{"host":"127.0.0.1","port":<port>}`). A hijacker who
     took the port in the release→bind window would have made the child's
     explicit bind fail and exit — the api never published, no entry, no
     navigation. Entry parsing is anchored to the closing brace so a longer
     port (`43189` ≠ `4318`) cannot satisfy a substring match.

**Live verification (final release binary):** a logging decoy bound to 4317
(the old default) + a planted stale `.dokan-port` = 4317. The app bound
**kernel-assigned port 50986**, the decoy log stayed EMPTY, the api published
`{"host":"127.0.0.1","port":50986}` under its pid, `/health` answered, the
window opened, and graceful close killed both processes.

**Rust unit tests (11 total, `cargo test` green):**
- `reserve_port_gets_a_kernel_port_distinct_from_any_occupied_one` — kernel
  never hands back an occupied port;
- `reservation_is_exclusive_while_alive` — THE regression: an active
  reservation is unbindable by anyone else; released, it is bindable again;
- `registry_owned_by_accepts_the_apis_own_entry` + rejects missing / wrong /
  longer / wrong-host entries;
- `verified` (token echo AND registry ownership) passes for the real child
  shape and rejects a decoy that 200s every path with the token echo (no
  registry entry);
- token generation (64 hex, unique), health-token echo acceptance/rejection
  (decoy 200, near-miss echo, dead port), kill-on-exit.

Also fixed in this round: the customer-slug rename glob no longer matches an
already-renamed artifact (double-slug bug) — only the pristine
`Dokan_<ver>_<arch>-setup.exe` is renamed (`findInstallerName`,
unit-tested).

## Gates (all green on HEAD 419ddbb)

| Gate | Result |
| --- | --- |
| `bun run typecheck` | pass |
| `bun run lint` | pass |
| `bun run test` | pass (api 228 + web + desktop pipeline 7) |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | 11 passed |
| `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --lib -- -D warnings` | pass |
| `DOKAN_PORT=4329 DOKAN_WEB_PORT=5185 bun run test:e2e --workers=1` | 13 passed |
| `.dokan-port` restore | baseline `4317` restored byte-exact (`cmp` clean) |

## Risks carried

- The release→bind window still exists mechanically (two processes cannot
  share one port), but a hijacker winning it makes the child's bind fail and
  exit — the pid-registry cross-check then blocks navigation; a same-user
  attacker with process surveillance AND file-forgery within that sub-second
  window is outside the shared-laptop threat model (noted in the design doc).
- Per-customer secret extraction risk and deferred fresh-install smoke are
  unchanged from the bbfc84d round.