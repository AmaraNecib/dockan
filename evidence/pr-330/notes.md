# PR #330 evidence — the vault gate's invalid-vault sentence

Captured 2026-10-20, headless Playwright from the repo's own `@playwright/test`,
no window on the desktop.

## Heads

| side | commit | worktree |
|---|---|---|
| after | `d71fce6a` "fix(web): close the defaultValue hole and correct the #322 claims" | `D:/worktrees/mani-project/fix-322-typed-i18n` |
| before | `ae9e416a` "test gate: a new test must be red on the parent before it can be green (#297)" | `D:/worktrees/mani-project/capture-330-before` (throwaway, detached, removed after capture) |

## How the invalid state was reached

Every boot used its own `DOKAN_DATA_DIR` with `${dataDir}/vault/vault.json` written
with 27 bytes of non-JSON (`not a vault header at all\x00\x01`). `VaultManager.status()`
maps the resulting `VaultFormatError` to `state: "invalid"` and does not fail boot, so
the API answers:

```json
{"mode":"vault","state":"invalid","legacyDatabase":false,"recoveryKeyCount":0,"lockedForMs":0,"unlocked":false,"broker":false}
```

No passphrase, no recovery key, no fixture data.

| side | api | web | data dir |
|---|---|---|---|
| after | `DOKAN_PORT=4461` | `DOKAN_WEB_PORT=5191` | `.scratch/evidence/pr-330/data-after` |
| before | `DOKAN_PORT=4462` | `DOKAN_WEB_PORT=5192` | `.scratch/evidence/pr-330/data-before` |

Both pairs re-checked free after teardown (see the report).

## The alert, exact text

Before (`ae9e416a`) — the catalogue had no `vaultInvalid` key, so `t()` fell back to
the identifier itself and the owner read the raw key:

```
vaultInvalid
```

After (`d71fce6a`) — `i18n.ts` carries the key:

```
تعذّر فتح خزنة البيانات: ملفّها تالف أو غير مكتمل. استعد أحدث نسخة احتياطية ثم أعد المحاولة.
```

Element: `[data-testid="vault-error"]`, `role="alert"`, inside the vault gate frame.
The gate gives this alert focus, so the screenshot and the video both show the real
focus ring.

## Stills

Both captured with `capture-still.mjs`: viewport 1440x900, `deviceScaleFactor: 3`,
`locale: ar-DZ`, element screenshot of the alert only — never the window.

| file | css size | png size | bytes | sha256 (16) |
|---|---|---|---|---|
| `before-invalid-vault.png` | 334x20 | 1002x60 | 3,514 | `13a042dd4621cfdc` |
| `after-invalid-vault.png` | 334x40 | 1002x120 | 20,063 | `3e281b6a93aebe73` |

The height doubles because the Arabic sentence wraps to two lines at the same width.

## Recording

`capture-video.mjs`, after side, viewport 1280x720, no CPU or network throttling —
this is the real mount. Three genuine mounts (open, reload, reload) with a dwell so the
sentence can be read. Measured marks: alert visible at 0.46 s, 10.74 s, 21.01 s after
the recording started.

Playwright's own 25 fps webm is kept in `video-raw/` as the source.

| file | duration | fps | size | frame | bytes | sha256 (16) |
|---|---|---|---|---|---|---|
| `pr-330.mp4` | 30.000 s | 15 | 1280x720 | CRF 18, x264, faststart | 152,467 | `c6e96ff31530f01f` |
| `pr-330.gif` | 5.000 s (60 frames) | 12.5 | 1280x720 | palettegen/paletteuse, 192 colours | 265,915 | `7ecc1230a32bc9cf` |

The mp4 is the whole 30 s recording. The GIF is a trim of the same recording — the
first 5 s, which holds the mount transition and then enough stillness to read the
sentence — because a 30 s GIF at this size is a file nobody can load. Nothing in the
GIF is staged or slowed; the transition is as fast as it actually is (blank paint →
unstyled app shell → styled gate with the alert).

## Teardown

Both server pairs were killed and ports 4461, 4462, 5191 and 5192 verified free.
The after worktree `fix-322-typed-i18n` was left at `d71fce6a` with a clean tree.
`git worktree remove` on the throwaway before-worktree failed partway with
`failed to delete 'D:/worktrees/mani-project/capture-330-before': Directory not empty`
(a Windows handle on `node_modules`); git deregistered the worktree anyway, so 185 MB
of files are left in that path and need one approved `rm -rf` to clear.

Reproduce the stills with `node capture-still.mjs <webUrl> <outPath>`; reproduce the
recording with `node capture-video.mjs <webUrl> <videoDir>`.

