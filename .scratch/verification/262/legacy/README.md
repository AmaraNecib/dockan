# Frozen pre-migration sources — evidence, never installed

These are the five shell scripts as they stood before issue #262 converted them to
TypeScript on Bun, copied here verbatim:

| file | frozen at |
| --- | --- |
| `crew-pickup.sh` | 351 lines, main repo working tree, 2026-10-17 11:58 |
| `crew-loop.sh` | 154 lines, **recovered from the pre-migration read at 12:05** |
| `e2e-slot.sh` | 172 lines, 2026-10-15 |
| `crew-clean.sh` | 95 lines, 2026-10-17 12:13 |
| `herdr-wake.sh` | 95 lines, `~/.pi/agent/bin/herdr-wake.sh` |

They exist for two reasons, and neither is sentiment.

1. **The diff-proof (rule 5).** "For each script, run both versions against the same
   inputs and diff the output." A proof you cannot re-run is a claim. `e2e-slot.sh`
   and `herdr-wake.sh` are diffed by `scripts/crew/parity.test.ts` on every
   `bun run test`; the live-state diffs (`crew-pickup --dry-run`, `crew-clean
   --dry-run`, `crew-loop status`) are recorded in
   `.scratch/verification/262/<sha>-diffproof.md`.
2. **Reversibility.** `.scratch` is untracked in the main repo's working tree, so
   replacing a `.sh` there deletes the implementation with no way back. That is the
   reason the queue's own shim gives for existing, and it applies to these four.

`crew-loop.sh` needed recovering rather than copying: while this lane was working, a
concurrent writer in the main repo replaced it with a forwarding shim of its own, so
the 154-line implementation no longer existed on disk. The copy here is the file as
read at 12:05, before that write.

Nothing calls anything in this directory. Deleting it is safe once the parent is
satisfied with the diff-proof; the converted implementations and their tests are
`scripts/crew/*.ts`.
