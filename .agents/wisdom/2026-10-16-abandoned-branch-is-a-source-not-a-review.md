# Wisdom: an abandoned branch is a source, not a review

Seen three times while landing carried-over work: #207, #113, #227. Each time a lane found a
pre-existing branch for its ticket, and each time the tempting move was to treat it as *the work*.

## A pin inherited from another branch can be hollow (🔴 Blocker class)

`fix-113-auth-errors` looked complete and its commit message was **accurate about its intent**. But its
item-1 pins selected the error paragraph **by `id` without asserting the `role`** — so they passed
against the very double-announcement mutant they claimed to catch. Its item-3 parity test asserted
`serverErrorKey(code) === code`, which a legitimate later alias (`INVALID_PARTY_PHONE`) breaks, making
it stale rather than wrong.

A later source change or a stale assertion can **hollow a pin while the suite stays green**. This is the
same failure as `2026-10-15-test-helper-vacuous-guard-and-inherited-mutation-claims`, one step further
back: there, a mutation claim was inherited; here, the *pin* was.

**Always**: re-run every inherited mutation on the current base before trusting a pin. A pin you did not
watch fail is a claim, not a gate.

## The commit message describes intent, which is exactly why it misleads (🟠 Major)

`203f5f6 fix(web): one auth-error announcement and no silent key drop` was an honest summary of what its
author *meant* to do. Reading it as evidence of what the code *does* is the mistake — intent statements
are true and still not verification. The only reliable read is the diff.

**Always**: read the diff commit by commit. Treat the message as a hypothesis to check.

## An abandoned branch or worktree blocks its ticket silently (🟠 Major)

`crew-pickup.sh` derives a lane label from the brief filename and skips an existing worktree. So a
branch or directory left behind by an earlier attempt **permanently prevents the ticket from starting**,
with no error — `#207`, `#113` and `#227` all sat idle this way. The same happened twice more in the
launcher itself: a failed `herdr worktree create` left a directory, and a failed launch left a *branch*,
and each blocked the next attempt.

**Always**: when reusing abandoned work, cherry-pick it onto the current base rather than branching from
it. Retire the old brief's `ISSUE:` header so the label cannot resolve to the stale one. And make the
launcher check for a **registered git worktree**, not the mere existence of a directory.

## Why this recurs

Three tickets in one session had an abandoned branch, because a lane that stalls gets closed and its
branch survives. That is a normal consequence of the workflow, not an accident — so **expect it** and
treat every stale branch as a lead, never as a starting point.
