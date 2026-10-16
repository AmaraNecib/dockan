# Wisdom: a refusal guard must record that it was asked

Found in #115, twice in two rounds: a guard that returns early while a flag is set, where the request it
refused is lost rather than deferred.

## The shape

```ts
if (importing) return;          // "not now" — and the request is gone
importing = true;
try { await importLegacy(); }
finally { importing = false; }  // nobody re-runs what we refused
```

The round-1 change existed to add a retry for a skipped import. Its guard then dropped that retry in a
**narrower** case: if the migration read and the failed write settled in the same turn, the failure
listener ran *before* `.finally()` cleared `importing`, so the only retry was refused **and forgotten**.

One microtask turn narrower than the bug it was written to remove.

## The fix is one bit, not a queue

```ts
if (importing) { retryPending = true; return; }
// in .finally():
importing = false;
if (retryPending) { retryPending = false; void importLegacy(); }
```

A second request while one is pending **is the same request**, so a bit is correct and a queue is
over-building. The distinction matters: a queue would imply requests are distinct, and would grow.

**Always**: when a guard refuses because something is in flight, ask *"who will re-ask?"* If the answer
is "nobody", the refusal is a silent drop. Record the ask.

## Where to look for it

Every refusal guard that has a **settled/reset counterpart**. The same change carried three more
instances of the shape, all named rather than fixed quietly:

- `GettingStartedSetting` disables the toggle when the preferences read errored
  (`disabled = isPending || isError || isWriting`), so a failed read makes the escape hatch **unreachable
  for the session** with no explicit retry — only refetch-on-focus or remount.
- `migrateLegacySidebarCollapsed`'s **own** write failing returns `null` and retries only next launch,
  while a competing write's failure retries in-session.
- The effect re-creates its `importing`/`retryPending` locals when `enabled` toggles
  true → false → true, so a failure inside the disabled gap is missed entirely.

## Testing it

**Release both promises in the same synchronous turn, with no `await` between.** A test that settles them
sequentially never exercises the interleaving, which is precisely how round 1's test missed it.

And when the fixed code makes the two orderings **observably identical at the end**, a black-box
assertion cannot discriminate them — so the discrimination belongs in a mutation (revert to the pre-fix
guard, watch the new test fail), recorded with command and exit code. Do not add an assertion that cannot
fail just to have one.

**Always**: for a "not now" guard, test the interleaving, not the sequence.
