# #285 visual evidence — vault locked-by-other-instance screen

Branch `t3/fix-vault-locked-screen`, head `c1e3824`.
Captured from worktree `D:\worktrees\mani-project\t3-fe3e107d` on 2026-10-18.

## Artifacts

All paths are absolute.

| artifact | absolute path | shows |
| --- | --- | --- |
| before (desktop) | `D:\worktrees\mani-project\t3-fe3e107d\.scratch\evidence\285\before.png` | develop's code, real refusal on the wire: the server-down screen — "تعذّر الاتصال بالخادم. تأكد من تشغيله ثم أعد المحاولة." with a retry button. Wrong story: the server is answering. |
| after (desktop) | `D:\worktrees\mani-project\t3-fe3e107d\.scratch\evidence\285\after.png` | this branch, same real refusal: "البيانات مفتوحة في نسخة أخرى من دكان على هذا المجلد. أغلق النسخة الأخرى ثم أعد فتح التطبيق." with the same retry button. |
| before (phone) | `D:\worktrees\mani-project\t3-fe3e107d\.scratch\evidence\285\before-phone.png` | the before screen at 390x844 |
| after (phone) | `D:\worktrees\mani-project\t3-fe3e107d\.scratch\evidence\285\after-phone.png` | the after screen at 390x844 |
| gif | `D:\worktrees\mani-project\t3-fe3e107d\.scratch\evidence\285\packet.gif` | 4 frames, 1s each, 1280x800, 35 KB: wrong screen held twice, then the refusal held twice |
| mp4 | `D:\worktrees\mani-project\t3-fe3e107d\.scratch\evidence\285\packet.mp4` | same 4s at 1280x800, h264, 24 KB |

Supporting files kept in the same directory: `capture.mjs` (the harness), `capture.log`
(timestamped run log), `frame1-4.png` and `before_cap.png` / `after_cap.png` (the captioned GIF/MP4
frames).

## Viewport

Desktop 1280x800 for `before.png`, `after.png`, `packet.gif`, `packet.mp4`. Phone 390x844 for the
two `*-phone.png`. Same desktop viewport for before and after. Locale `ar-DZ`; the app is
Arabic-only.

## State mechanism — real API, not a stub

The refusal is a **real API answering over the real Vite dev proxy**. No stub server, no
`page.route` interception, no hand-planted `vault.lock`.

The harness starts the API twice on one fresh temp data folder:

1. instance A takes the single-writer lock and serves `/api/vault/status` 200;
2. instance B on its own port cannot take the lock and serves the #275 refusal app — its
   `/api/vault/status` answers `503 {"error":{"code":"VAULT_LOCKED_BY_OTHER_INSTANCE"}}`, confirmed
   live in `capture.log`;
3. a Vite dev server boots with `DOKAN_PORT` pointed at instance B, so the browser's
   `/api/vault/status` request leaves the page, crosses the proxy, and lands on the refusing
   process. That is the whole path a real second instance produces.

The refusal body is captured from the running process, not invented. Nothing about the transport is
faked.

The **before** state is develop's own `App.tsx`, `vault-client.ts` and `vault-gate.tsx` served
against the same refusing API: the client throws away the code and the gate shows the server-down
copy. The harness checked those three files out from `develop`, captured, then restored `HEAD`; the
worktree is clean afterwards (`git status --porcelain` has only the untracked `.scratch/evidence/`).
No commit, no push, no GitHub.

## Commands run

Capture (through the heavy slot queue, one command):

```
cd /d D:\worktrees\mani-project\t3-fe3e107d && bun .scratch\evidence\285\capture.mjs
```

Inside it: `bun src/main.ts` twice from `apps/api` with a shared `DOKAN_DATA_DIR` and separate
`DOKAN_PORT`; `bun run --filter @dokan/web dev` with `DOKAN_PORT` = the refuser port; Playwright
`chromium` headless at the viewports above.

Media (the two captioned frames and the two outputs):

```
ffmpeg -y -i before.png -vf "drawtext=fontfile='C\:/Windows/Fonts/arial.ttf':text='develop - refusal read as server down':x=(w-text_w)/2:y=28:fontcolor=white:fontsize=26:box=1:boxcolor=black@0.72:boxborderw=14" before_cap.png
ffmpeg -y -i after.png  -vf "drawtext=fontfile='C\:/Windows/Fonts/arial.ttf':text='this branch - names the other instance':x=(w-text_w)/2:y=28:fontcolor=white:fontsize=26:box=1:boxcolor=black@0.72:boxborderw=14" after_cap.png
ffmpeg -y -framerate 1 -i frame%d.png -vf "split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" -loop 0 packet.gif
ffmpeg -y -framerate 1 -i frame%d.png -vf "scale=1280:-2" -c:v libx264 -pix_fmt yuv420p -r 30 -movflags +faststart packet.mp4
```

GIF/MP4 frames: 1-2 = `before_cap.png`, 3-4 = `after_cap.png`.

## Caveats that change what a reader concludes

- The captions in `packet.gif` and `packet.mp4` are burned into the media frames only. `before.png`
  and `after.png` are raw screenshots with no overlay.
- The refusal comes from a **second API process on the same folder**, which is the production
  trigger but is not literally a hand-written `vault.lock` with a foreign pid. If you want the
  hand-planted-lock variant specifically, say so; this capture does not claim it.
- `before.png` is develop's web code served by the same Vite/harness as the after shot, not a build
  from a develop checkout. It is develop's three source files, unmodified.
- The retry button is present on both screens and was not clicked for these stills; the packet shows
  copy only, not post-retry navigation. The e2e spec covers retry-reaches-the-gate.
