# PR #301 (#295 client freshness) — visual evidence

What this shows: a sale posted in **window A** moves the counters in **window B**
without window B being clicked, focused or reloaded. The mechanism is the
bounded background tick in `apps/web/src/lib/freshness.ts` (5 s for the hot
counters, 15 s for the item ledger).

Everything here was captured **headless** (Playwright's own Chromium,
`recordVideo`). No visible browser window was opened on the owner's desktop.

App under test: worktree `D:/worktrees/mani-project/t3-8df8f3f0`
(branch `t3/295-client-freshness-1`, head `7998a8d`), web on
`http://127.0.0.1:5191`, api on `http://127.0.0.1:4461`.

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
| Sales counter, window B | `before-sales-count.png` / `after-sales-count.png` | The dashboard card's detail line, `عدد فواتير البيع: 3` → `عدد فواتير البيع: 4` (1050x48) |
| Sales card, window B (context) | `before-sales-card.png` / `after-sales-card.png` | The whole KPI card: `مبيعات اليوم 600 دجم` → `800 دجم`, count 3 → 4 (1128x309) |
| Low-stock row, window B | `before-low-stock-row.png` / `after-low-stock-row.png` | The row's number span, `5 / 5` → `4 / 5` (90x72 / 87x72) |
| Low-stock list, window B (context) | `before-low-stock-list.png` / `after-low-stock-list.png` | The whole list; the row's number is the only thing that changes (3456x591) |
| Stock cell, window A | `before-stock-window-a.png` / `after-stock-window-a.png` | The same item's stock cell on `/items` in window A: `5 منخفض` → `4 منخفض` (165x66 / 168x66) |
| Stock row, window A (context) | `window-a-low-stock-row.png` | Window A's own low-stock row after the sale, `4 / 5` (90x72) |

Measured on the run that produced these files: window B read `3` invoices /
`600 دجم` and `5 / 5` before the sale, and `4` invoices / `800 دجم` and `4 / 5`
**940 ms** after the sale was posted. The tick's phase relative to the sale is
arbitrary (the interval is 5 s), so 940 ms is a measurement, not a bound.

## 2. The recording

`pr-301-composite.mp4` — 1920x1080, 45.2 s, H.264 CRF 18.
`pr-301.gif` — 1280x720, 40.0 s, 12 fps, 5.2 MB.

The left half is **window A** (the sale page), the right half is **window B**
(the dashboard). The recording is two Playwright `recordVideo` streams — one per
window, 960x1080 each — composed side by side with `hstack`.

Timeline inside the composite:

| t | what happens |
|---|---|
| 0 s | both windows up; window B is already on the dashboard at `400 دجم` / `عدد فواتير البيع: 2` |
| ~11 s | window A opens `/sale` and types the barcode |
| 15.0 s | window A saves the sale — `تم حفظ فاتورة البيع رقم INV-0003` |
| 18.4 s | **window B flips on its own**: `600 دجم` / `عدد فواتير البيع: 3`, and the low-stock row goes `5 / 5` → `4 / 5` |
| 18.4–45 s | window B sits on the new numbers; window B is never clicked |

Window B's own event counters for that run: `focusEvents = 0`,
`blurEvents = 0`, `visibleFlips = 0`. TanStack v5's focus manager listens to
`visibilitychange`, so no visibility flip means the focus path never fired —
the bounded tick is the only refetch trigger that was left.

The GIF is trimmed to `t = 5 s … 45 s` (40 s) and is under the 8 MB budget at
the prescribed settings (`fps=12`, `scale=1280:-1:flags=lanczos`,
`palettegen=max_colors=192`, `paletteuse=dither=bayer:bayer_scale=3`).

## 3. The raw sources and the script

- `capture.cjs` — the throwaway capture script (headless only). Not part of the
  repository; it lives in this evidence folder.
- `capture-result.json` — the machine-readable numbers (before/after values,
  timings, event counters) for both runs.
- `.video-src/*.webm` — the two untouched Playwright recordings the composite
  was built from (45.2 s and 62.9 s, 960x1080, VP8).

## 4. ffmpeg commands

```bash
# the two per-window recordings -> one 1920x1080 video, window A left, window B right
ffmpeg -y -i .video-src/page@1caeba8628149305eee8ea093b8bfc62.webm \
          -i .video-src/page@3a16b68bd335a905dbec002511c5255e.webm \
  -filter_complex "[0:v]scale=960:1080,fps=25,setpts=PTS-STARTPTS[a]; \
                   [1:v]scale=960:1080,fps=25,setpts=PTS-STARTPTS[b]; \
                   [a][b]hstack=inputs=2:shortest=1" \
  -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p pr-301-composite.mp4

# the composite -> the inline gif (trimmed to t=5s..45s)
ffmpeg -y -ss 5 -t 40 -i pr-301-composite.mp4 \
  -vf "fps=12,scale=1280:-1:flags=lanczos,split[a][b]; \
       [a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=bayer:bayer_scale=3" \
  pr-301.gif
```
