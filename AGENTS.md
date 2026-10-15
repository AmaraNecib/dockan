# Agent notes

## e2e ports and lanes

`DOKAN_PORT`/`DOKAN_WEB_PORT` isolate the shared api/web pair, and the vault
spec honours `DOKAN_VAULT_PORT`/`DOKAN_VAULT_WEB_PORT` (defaults 4399/5174) for
its dedicated pair. Set both pairs per lane and vault-touching e2e runs coexist:
they no longer have to be serialized across lanes. (The one-lane constraint that
PR #199 documents is relaxed by #202, which made the vault pair configurable;
do not reintroduce it when #199 rebases onto this branch.)

## Search scope

Scope every filesystem search (`find`, `grep`, `rg`, glob) to this repository
root or a specific subdirectory — e.g. `find . -name "*.ts"` from the repo
root. Never search from `/` (the filesystem root): scans of the whole disk are
slow and waste the session.
