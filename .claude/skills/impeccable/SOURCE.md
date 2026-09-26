# Source

**Origin:** Third-party skill — impeccable **v4.4.0** (from `metadata.version` in `SKILL.md`; previously pinned at v3.9.1).
**From:** `pbakaus/impeccable`.
**Get it:** `npx skills add pbakaus/impeccable` — the generic skills CLI (v1.7.0), project scope.
**License:** not declared.

## Why it is installed through the skills CLI

The skill ships its own update channel, and it is currently broken:

```
npx impeccable update --project --yes
npx impeccable install --project --yes --force
→ Download failed: Could not verify skill bundle: HTTP 404
  ... report it at https://github.com/pbakaus/impeccable/issues/479
```

`npx impeccable check` fails the same way. The CLI resolves to 4.1.0 and `impeccable@3.9.1` is not a published npm version (ETARGET). Both the `update` and `install` verbs fail at bundle verification, so the channel was bypassed in favour of `npx skills add`, which clones the repository directly.

Retry the native channel once pbakaus/impeccable#479 is fixed, and compare before replacing what is here.

## Tracking

Unlike the previous copy, this skill is now listed in `skills-lock.json`:

```json
"impeccable": {
  "source": "pbakaus/impeccable",
  "sourceType": "github",
  "skillPath": ".agents/skills/impeccable/SKILL.md",
  "computedHash": "d55800186ff7651be356015b103047b9dd84f83172cc257042a322491df3502e"
}
```

So future refreshes can go through the same lock-driven path as the other vendored skills.

## Setup this version expects

Step 1 of `SKILL.md` requires running the launcher once per session, from the user's project directory:

```
.agents/skills/impeccable/scripts/impeccable context
```

On a Windows shell without `sh`, call `.agents/skills/impeccable/scripts/impeccable.cmd`. The launcher runs a self-contained binary that ships beside it or is downloaded on first run — no Node or other runtime is required. It loads `PRODUCT.md`, `DESIGN.md`, the matching surface brief, and native-platform guidance.

`$impeccable doctor` reports drift between this project's Impeccable artifacts and what the version expects.

**This repository has not adopted `PRODUCT.md` / `DESIGN.md` yet.** The design context currently lives in `.impeccable.md`. The first real use of this skill should decide whether to migrate that context into the artifacts v4 reads, rather than letting the launcher invent missing context.

## Packaging note

The skills CLI installs `.claude/skills/impeccable` as a **junction** to `.agents/skills/impeccable`. This repository commits real copies in both directories for every other vendored skill, and it does not commit links — a recursive delete through a junction has already destroyed content once in this project. The copy here is a real directory, kept byte-identical to the `.agents` copy.
