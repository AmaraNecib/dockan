# Durable lessons learned while building Dokan

**One file per lesson. The category folder says where it lives; the filename says what it teaches.**
No dates in filenames — a lesson that recurs is the same lesson, and a dated filename makes the
second occurrence look like a new one.

## Shape

```
wisdom/
  api/           seams, router, store, resolvers
  architecture/  design principles that outlive a ticket
  data/          schema, identity, ranges, pagination
  e2e/           Playwright and browser-run mechanics
  money/         ledger, FIFO, balances, adjustments
  packaging/     desktop and portable builds
  process/       lanes, reviews, CI config, git traps
  testing/       unit and integration test design
  vault/         vault, crypto and lock lifecycle
  web/           React, RTL, i18n, forms, printing
```

## When a lesson repeats

**Append to the existing file.** Do not create a second file because the date changed or the ticket
number is different. Add the new occurrence to the file's body — a `Seen in:` line naming the issues
or PRs — and strengthen the rule if the recurrence taught you something the first one did not.

Two files that teach the same thing are worse than one file: the next lane reads one of them, misses
the other, and re-derives the lesson a third time.

## Who writes

**The parent session only.** A lane reads this folder, applies what bears on its task, and reports
which lessons it applied and which it deliberately did not. A candidate lesson goes in the `lesson`
field of its report. One occurrence is a report line, not wisdom: the parent writes an entry when the
same failure shows up across reports.

## How to read it

Do not read all of it. Grep for your area first, then read only the hits:

```bash
grep -rin "<your area, symbol or failure mode>" .agents/wisdom/ | head -40
```

The older entries carry a `**Date:**` and `**Ticket:**` line inside the file. That provenance is
worth keeping — it is how a reader finds the PR that produced the lesson. It just does not belong in
the filename.
