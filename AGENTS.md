# Agent notes

## Search scope

Scope every filesystem search (`find`, `grep`, `rg`, glob) to this repository
root or a specific subdirectory — e.g. `find . -name "*.ts"` from the repo
root. Never search from `/` (the filesystem root): scans of the whole disk are
slow and waste the session.
