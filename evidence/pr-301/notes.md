# PR #301 (#295 client freshness) — visual evidence

**Head captured: `6c6c8cae`** (`git rev-parse HEAD` in the worktree reads
`6c6c8caef8e06a8c490d1bfd8f621de08636e1ff`, branch `t3/295-client-freshness-1`).
The previous packet in this folder read `7998a8d` and was three commits stale.

What this shows: a sale posted in **window A** moves the counters in **window B**
without window B being clicked, focused or reloaded. The mechanism is the
bounded background tick in `apps/web/src/lib/freshness.ts` (5 s for the hot
counters, 15 s for the item ledger).

Everything here was captured **headless** (Playwright's own Chromium,
`recordVideo`). No visible browser window was opened on the owner's desktop.

App under test: worktree `D:/worktrees/mani-project/t3-8df8f3f0`
(branch `t3/295-client-freshness-1`, head `6c6c8cae`), web on
`http://127.0.0.1:5191`, api on `http://127.0.0.1:4461`, `DOKAN_VAULT=disabled`,
data dir `.scratch/evidence-run/data-final` (fresh). Both servers were killed
after the run; nothing was left listening.

Full console output of the run: `capture-log.txt`. Machine-readable numbers:
`capture-result.json`, written by the script after every phase.

---

## 1. The element screenshots (before / after)

Window B is a second browser session on the same api. It sits on the dashboard
and is never touched between the two shots: no click, no focus, no reload.
Window A sells one unit of an item seeded with `stockOnHand = 5` and
`lowStockThreshold = 5`, so the item is already on the low-stock list and the
row's number changes from `5 / 5` to `4 / 5`.

Both sides of every pair were taken at the **same viewport (1440x900)** and the
same `deviceScaleFactor` (3), so they render at one display width.

| Surface | File | What it is |
|---|---|---|
| Sales counter, window B | `before-sales-count.png` / `after-sales-count.png` | The dashboard card's detail line, `عدد فواتير البيع: 4` → `5` (1050x48) |
| Sales card, window B (context) | `before-sales-card.png` / `after-sales-card.png` | The whole KPI card: `مبيعات اليوم 800 دجم` → `1,000 دجم`, count 4 → 5 (1128x309) |
| Low-stock row, window B | `before-low-stock-row.png` / `after-low-stock-row.png` | The row's number span, `5 / 5` → `4 / 5` (87x72 / 90x72) |
| Low-stock list, window B (context) | `before-low-stock-list.png` / `after-low-stock-list.png` | The whole list; the row's number is the only thing that changes (3456x150) |
| Stock cell, window A | `before-stock-window-a.png` / `after-stock-window-a.png` | The same item's stock cell on `/items` in window A: `5 منخفض` → `4 منخفض` (165x66) |
| Stock row, window A (context) | `window-a-low-stock-row.png` | Window A's own low-stock row after the sale, `4 / 5` (90x72) |

**Measured on this run**: window B read `4` invoices / `800 دجم` and `5 / 5`
before the sale, and `5` invoices / `1,000 دجم` and `4 / 5` **428 ms** after the
sale was posted. The tick's phase relative to the sale is arbitrary (the
interval is 5 s), so 428 ms is a measurement, not a bound.

## 2. The away row — the surface round 4 changed

`6c6c8cae` is *"the away row is read, not copied"*. At `7998a8d` this surface did
not exist at all: `git show 7998a8d:apps/web/src/pages/items.tsx` has no
`draft.row`, no `data-off-page` and no `itemsAll`. Round 3 introduced the
keep-alive (`draft.row`, a snapshot); round 4 replaced the snapshot with a read
(`liveDraftRow` = page row → `itemsAll` row → snapshot as last resort). The pair
below is what that fix exists for.

Setup, all of it a real user path:

1. Window B is on `/items` with a page window of two rows.
2. The operator opens the editor on the second row (`ز-صنف-…`, stock 6,
   threshold 5 — not low yet).
3. Window A creates one item whose name sorts ahead of it (`ب-وارد-…`). The 5 s
   poll re-reads the list, the page window becomes `أ-حاجز` + `ب-وارد`, and the
   edited row **leaves the page**.
4. Window A sells one unit: 6 → 5, which crosses the threshold, so the badge has
   to appear as well as the number.

| Surface | File | What it is |
|---|---|---|
| Away row, window B | `before-away-row.png` / `after-away-row.png` | The whole `<tr>`: the row is off the page (`data-off-page="true"`), its editor is still open (`data-editing="true"`, حفظ/إلغاء both there), and the stock cell goes `6` → `5 منخفض` (3450x177) |
| Away stock cell | `before-away-stock-cell.png` / `after-away-stock-cell.png` | Just the cell, at 3x: `6` → `5 منخفض`. The width differs because the badge is new (30x66 / 165x66) |
| Items table, window B (context) | `before-away-table.png` / `after-away-table.png` | Page 1 before the push (2 rows, editor open on row 2), then after: page 1 is `أ-حاجز` + `ب-وارد` and the away row is appended below it with its editor and its moved number (3450x456 / 3450x603) |

**`after-away-row.png` is the screenshot that proves the round-4 fix.** Its stock
cell reads `5 منخفض` while the row is off the page window and its editor is
still open; at `b3f133fd` that cell would have stayed at the edit-time `6`, with
no badge, for as long as the edit stayed open.

**Measured on this run**: the away row's cell moved from `6` to `5 منخفض`
**2,882 ms** after window A saved the sale. Window B's own counters for that
window: `clicks = 0`, `focusEvents = 0`, `navigations = 0` after the one click
that opened the editor, and `data-off-page` was `true` throughout.

## 3. The recording

`pr-301-composite.mp4` — 1920x1080, 44.92 s, H.264 CRF 18, 2.0 MB.
`pr-301.gif` — 1280x720, 35.0 s, 12 fps, 5.3 MB, trimmed from composite t=5 s..40 s.

The left half is **window A** (the sale page), the right half is **window B**
(the dashboard). The recording is two Playwright `recordVideo` streams — one per
window, 960x1080 each — composed side by side with `hstack`.

Both panels carry a **shared wall clock** (UTC, milliseconds) burned in by
`capture.cjs`, bottom-left. That is a change from the `7998a8d` packet, and it is
there because two Playwright recordings from one browser do not start on the
same instant: a blind `setpts` reset can put B's flip *before* A's save, which
would make the composite argue against the claim it exists to support. The
offset was measured at video t=10 s — A `14:03:55.047`, B `14:03:55.032`, so
**15 ms** — and applied as a 15 ms delay on B. It also keeps both pages
repainting, which is why both recordings are now ~45 s instead of 45.2 s and
62.9 s.

Timeline inside the composite (composite time = window A's time):

| t | what happens |
|---|---|
| 0 s | both windows up; window B is already on the dashboard at `1,000 دجم` / `عدد فواتير البيع: 5` |
| ~10 s | window A opens `/sale` and types the barcode |
| 15.75 s | window A saves the sale — `تم حفظ فاتورة البيع رقم INV-0006` |
| 18.94 s | **window B flips on its own**: `1,200 دجم` / `عدد فواتير البيع: 6`, and the low-stock row goes `5 / 5` → `4 / 5` |
| 18.94–44.9 s | window B sits on the new numbers; window B is never clicked |

Checked on the encoded file, not just the log: at composite t=18.6 s the right
half still reads `1,000 دجم` / `5`; at t=19.6 s it reads `1,200 دجم` / `6`.

Window B's own event counters for that run: `focusEvents = 0`, `blurEvents = 0`,
`visibleFlips = 0`. TanStack v5's focus manager listens to `visibilitychange`, so
no visibility flip means the focus path never fired — the bounded tick is the
only refetch trigger that was left.

## 4. The raw sources and the script

- `capture.cjs` — the throwaway capture script (headless only). Not part of the
  repository; it lives in this evidence folder. `PHASE` selects `preseed`,
  `shots`, `video`, `away` or `all`, and it writes `capture-result.json` after
  every phase so a failing later phase cannot cost the earlier ones their
  numbers.
- `capture-log.txt` — the run's console output.
- `capture-result.json` — the machine-readable numbers (before/after values,
  timings, event counters, artifact metadata, clock alignment).
- `.video-src/*.webm` — the two untouched Playwright recordings the composite was
  built from (`page@7500384f…` = window A, `page@4b549905…` = window B, ~44.9 s
  each, 960x1080, VP8).

## 5. ffmpeg commands, as run

```bash
# the two per-window recordings -> one 1920x1080 video, window A left, window B right.
# 0.015 is the measured clock offset between the two recordings; B is delayed by it.
ffmpeg -y -i .video-src/page@7500384f46c223abcfd25f958f5e3dd9.webm \
          -i .video-src/page@4b549905e3f220f7d60f5ee19a45c2fb.webm \
  -filter_complex "[0:v]scale=960:1080,fps=25,setpts=PTS-STARTPTS[a]; \
                   [1:v]scale=960:1080,fps=25,setpts=PTS-STARTPTS+0.015/TB[b]; \
                   [a][b]hstack=inputs=2:shortest=1" \
  -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p pr-301-composite.mp4

# the composite -> the inline gif (trimmed to t=5s..40s)
ffmpeg -y -ss 5 -t 35 -i pr-301-composite.mp4 \
  -vf "fps=12,scale=1280:-1:flags=lanczos,split[a][b]; \
       [a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=bayer:bayer_scale=3" \
  pr-301.gif
```

## 6. What differs from the `7998a8d` packet

1. **Head.** `6c6c8cae` here, `7998a8d` there — three commits, three behaviour
   changes.
2. **A new surface.** The away row did not exist at `7998a8d`, so §2 above is
   new evidence rather than a re-shoot. It is the reason this packet was
   re-captured.
3. **The numbers on the card.** `800 → 1,000` here against `600 → 800` there,
   because the shop was fresh and was pre-seeded with four invoices. Both moves
   are one invoice of 200 دجم.
4. **The low-stock list is one row (150 px tall) instead of five (591 px)** — fresh
   shop, one seeded low-stock item.
5. **The recording carries a clock, and the panels are aligned by measurement**
   (§3). The old composite's alignment was never checked and the two source
   recordings did not start together.
6. **Latency was measured three times, not twice**: 428 ms (element stills),
   3,191 ms (recording), 2,882 ms (away row). The `7998a8d` packet measured
   940 ms and 3,391 ms. Same 5 s tick; the phase of that tick against the sale
   is what varies.
7. **`capture-result.json` is script-written.** The old one was rebuilt by hand
   after a second run overwrote the first run's file.
