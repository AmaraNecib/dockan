# PR #345 (issue #321) — the purchase screen's discard question: before/after packet

**The change does what the issue says, and it is the only thing standing between a cart and a
sidebar click.** On develop one click on «الزبائن» leaves the purchase screen immediately: the line,
the typed note and the quick-add form land in the bin with no prompt. On the branch the same click
raises «تجاهل فاتورة الشراء؟», names how many lines would go, and «البقاء في الفاتورة» puts the
caret back in the note field with the cart untouched. The browser Back button behaves the same way.

Everything below was measured in a browser against two live servers, one per side. No file in either
worktree was edited to make a frame.

---

## Sides

| | commit | worktree | api | web | data |
|---|---|---|---|---|---|
| before | `develop` **a8d663bc** | `D:/worktrees/mani-project/evidence-345` | 4461 | 5461 | `data-before/` |
| after | **74b2064c** (the PR head) | `D:/worktrees/mani-project/evidence-345-after` | 4462 | 5462 | `data-after/` |

`DOKAN_VAULT=disabled` on both sides, so both meet the plaintext login the e2e suite uses. Each side
ran first-run setup through the UI, so each has its own owner account and its own seeded «عام»
category.

**The develop head is not the one the brief pinned.** The brief said `7fa513bb`; `origin/develop` was
`a8d663bc` (*"docs(wisdom): a push cancels the run…"*) when I created the checkout, and I used it.

**The branch worktree in the brief was being edited while I worked.** `D:/worktrees/mani-project/t3-cfad02e3`
sits at `74b2064c` but its tree is **dirty** — `apps/web/src/pages/purchase.tsx`, `sale.tsx` and
`invoice-draft.test.ts` modified, a new untracked `apps/web/src/lib/purchase-quick.ts`, plus three
`.scratch-*.txt` files. Vite hot-reloaded those files into the running app (twice, mid-probe). A frame
from that server would have been a frame of unpushed work, so I checked out the pinned commit into a
clean detached worktree (`evidence-345-after`) and filmed that instead:
`git rev-parse HEAD` was `74b2064c` with `git status --porcelain` empty before and after every run.

## Reproduce

```bash
# one-time: a clean checkout of each side, with its own dependencies
git -C D:/projects/mani-project worktree add D:/worktrees/mani-project/evidence-345 origin/develop
git -C D:/projects/mani-project worktree add --detach D:/worktrees/mani-project/evidence-345-after 74b2064c
cd D:/worktrees/mani-project/evidence-345       && bun install --frozen-lockfile
cd D:/worktrees/mani-project/evidence-345-after && bun install --frozen-lockfile

# before: api 4461, web 5461
cd D:/worktrees/mani-project/evidence-345 \
  && DOKAN_PORT=4461 DOKAN_DATA_DIR=D:/projects/mani-project/.scratch/evidence/pr-345/data-before \
     DOKAN_VAULT=disabled bun run --filter @dokan/api start &
cd D:/worktrees/mani-project/evidence-345 \
  && DOKAN_WEB_PORT=5461 DOKAN_PORT=4461 bun run --filter @dokan/web dev &

# after: the same with 4462 / 5462 and evidence-345-after / data-after

cd D:/projects/mani-project/.scratch/evidence/pr-345
bun drive.ts before stills   # 2x element crops  -> before.png
bun drive.ts after  stills   # 2x element crops  -> after.png
bun drive.ts before video    # 1280x720 recording -> raw/video-before/ (32.3 s)
bun drive.ts after  video    # 1280x720 recording -> raw/video-after/  (34.0 s)

# the deliverables, from the recorded webm
for side in before after; do
  src=$(ls raw/video-$side/*.webm)
  ffmpeg -y -i "$src" -vf "fps=30,scale=1280:720:flags=lanczos" \
     -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p -movflags +faststart "$side.mp4"
  ffmpeg -y -i "$src" -filter_complex \
     "fps=10,scale=800:450:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" \
     -loop 0 "$side.gif"
done
```

`drive.ts` is the whole run: chromium (Playwright 1.62.1, headless, `locale: ar-DZ`), first-run setup,
login, then on `/purchase` a product created through the screen's own quick-add (qty 2, unit cost 300,
category «عام»), a typed note, the sidebar click, and finally a second cart and the browser Back
button. The caret is left in the note field so the run can measure where «stay» sends it.

**Two passes, on purpose.** The video pass runs at `deviceScaleFactor: 1`, the stills pass at `2`. At
dsf 2 the recorder composited the dialog at 2x for a frame or two while it left the top layer, which
showed as a full-frame flash of a magnified dialog; the dsf-1 recording has no such frame, and the
stills pass is where the native-pixel crops come from. Each pass creates its own product, so the item
name differs between `after.png` and `after.gif` (`كرتون-6228870` in the stills pass,
`كرتون-6258591` in the video pass, `before.png` `كرتون-6239733`, `before.gif` `كرتون-6292516`). The
dialog crop shows no item name; the supporting shots under `raw/` do.

## The dialog, measured on the after side

Read off the rendered DOM (`after-run-stills.json` → `exit1.dialogText`), line breaks as Box renders
them:

```
تجاهل فاتورة الشراء؟

عدد أسطر الفاتورة التي ستُفقد: 1. هل تريد المتابعة؟

البقاء في الفاتورة            تجاهل الفاتورة
```

- title — `تجاهل فاتورة الشراء؟`
- body — `عدد أسطر الفاتورة التي ستُفقد: 1. هل تريد المتابعة؟` (the count is the cart's line count)
- the answer that keeps the work — `البقاء في الفاتورة` (`data-testid="purchase-discard-stay"`)
- the destructive answer — `تجاهل الفاتورة` (`data-testid="purchase-discard-confirm"`, destructive
  variant)

**The brief predicted a different title.** It said «مغادرة الفاتورة؟». The branch ships
«تجاهل فاتورة الشراء؟» and the body above. The behaviour matches the brief; the copy does not.

## What survived «stay»

Same run, `exit1.stayed` (and `exit2.stayed` for the Back exit — identical values):

| field | before the click | after «البقاء في الفاتورة» |
|---|---|---|
| cart line | `كرتون-6228870 — منتج جديد` | `كرتون-6228870 — منتج جديد` |
| quantity | `2` | `2` |
| unit cost | `300` | `300` |
| line total | `600 دج` | `600 دج` |
| invoice total | `600 دج` | `600 دج` |
| note | `ملاحظة-6228870 طرف ثانٍ` | `ملاحظة-6228870 طرف ثانٍ` |
| focus | `input[name=notes]` | `input[name=notes]` |

The last row is the caret: the question opens with focus on «البقاء في الفاتورة», and closing it puts
the caret back in the field the owner was typing in (`finalFocus` → the form's last-focused control).

## The loss on develop

`before-run-video.json`: after the same click, `exit1.dialog = null` and the page is `/customers`
within one frame. Walking back to `/purchase` through the sidebar gives `lineText: null`,
`lineQty: null`, `note: ""` — the empty state «أضف أول منتج إلى الفاتورة». The Back exit is the same:
`exit2.dialog = null`, landed on `/customers`. **Develop never asks.**

## Artifacts

### The pair the gate reads

| file | pixels | what it shows |
|---|---|---|
| `D:/projects/mani-project/.scratch/evidence/pr-345/before.png` | 1984×958 | develop, the purchase form after coming back from «الزبائن»: supplier empty, note empty, «أضف أول منتج إلى الفاتورة», nothing kept |
| `D:/projects/mani-project/.scratch/evidence/pr-345/after.png` | 768×284 | the branch, the question itself, cropped to the dialog element at 2x |

**The two PNGs are not pixel-comparable and are not meant to be.** The change is the appearance of a
dialog; on develop there is no dialog to crop, and its nearest neighbour in the same region is the
form the owner is dumped back into with the work gone. `before.png` is the purchase form element
(the region the dialog covers), not the customers screen it landed on — the customers screen is in
`raw/before-customers-landed.png` for anyone who wants to see where develop actually sent the click.
The frames that *are* comparable are in the videos: the same cart, the same click, two outcomes.

### Playback

| file | pixels | length | what it shows |
|---|---|---|---|
| `before.gif` | 800×450, 10 fps, 323 frames | 32.3 s | cart built → click «الزبائن» → the customers screen, no question → back to an empty purchase form; then a second cart → Back → the customers screen again |
| `after.gif` | 800×450, 10 fps, 340 frames | 34.0 s | cart built → click «الزبائن» → the question over the dimmed cart → «البقاء في الفاتورة» → the cart still there; then a second cart → Back → the question again → stay |
| `before.mp4` | 1280×720, h264 CRF 18, 30 fps | 32.3 s | the same, full size |
| `after.mp4` | 1280×720, h264 CRF 18, 30 fps | 34.0 s | the same, full size |

Both loops are the real thing at real speed. The only timing change is the pause length between
steps (`PACE` in `drive.ts`: 1.9× on develop, 1.5× on the branch) so each recording lands in the
30–45 s window; no frame is dropped, duplicated or re-timed.

### Supporting stills under `raw/`

| file | pixels | why it exists |
|---|---|---|
| `raw/after-dialog-context.png` | 2560×1440 | the question in context: dialog over the dimmed cart it is protecting |
| `raw/after-cart-kept.png` | 2560×1440 | the same cart after «stay» — line, qty, cost, note |
| `raw/before-customers-landed.png` | 2560×1440 | where develop actually lands the click: «الزبائن» |
| `raw/{before,after}-run-{stills,video}.json` | — | every snapshot the run took, plus the navigation log and the mark timings |
| `raw/api-*.log`, `raw/web-*.log` | — | the two servers |
| `raw/video-{before,after}/*.webm` | 1280×720 | the recordings the mp4s and gifs were cut from |
| `raw/scan-*`, `raw/frame-*`, `raw/v-*`, `raw/webm-*` | 1280×720 or 640×360 | the frames I read to check that the dialog appears where the marks say it does, and that no frame carries the magnified-dialog artifact |
| `raw/probe*.ts`, `raw/probe-after.png` | 1280×720 | the throwaway probes that found the quick-add category requirement |
| `raw/superseded/` | — | the three earlier attempts: dsf-2 recordings with the magnified-dialog frame, and the run against the dirty worktree |

## Things that did not behave as predicted

1. **Develop does not prompt, on either exit.** This is the finding the packet needed to confirm, and
   it is the one that makes the PR necessary.
2. **The dialog title is «تجاهل فاتورة الشراء؟», not the brief's «مغادرة الفاتورة؟».** Same behaviour,
   different copy. If the copy in the issue was the intent, the branch and the issue disagree.
3. **On the Back exit the address bar reads `/customers` while the question is up.** The router's
   blocker (`withResolver`) moves the history entry and then restores it when the answer is «stay», so
   `location.pathname` is `/customers` at the moment of `exit2.asked` and `/purchase` right after
   `exit2.stayed`. The screen never leaves; only the URL is briefly ahead of it. A screenshot of the
   Back-exit dialog would show this, which is why `after.png` is cropped from the sidebar exit.
4. **The quick-add form refuses a product with no category** («اختر تصنيفاً أو أنشئه أولاً»), so the
   run has to pick «عام» before it can add the first line. Not a defect — a step the driver has to
   take, recorded here so the next person does not spend a run finding it.
5. **The «no lines but something typed» copy was not exercised.** `purchasesDiscardDescNoCart`
   («على هذه الفاتورة عمل لم يُحفظ بعد…») needs a dirty screen with an empty cart (a typed supplier
   or note alone); this run always had one line, so the count branch is what the pixels show.
6. **The paid-now field shows a suggested `600` / `100%` on both sides** once the cart totals 600 —
   `resolvedInitialPaid`, unchanged by this PR. It is not a branch difference; it is visible in both
   videos because both carts total the same.

Model: `opencode-go/deepseek-v4.1-flash` · Thinking: high · Harness: pi (T3 Code) · Agent: evidence lane
