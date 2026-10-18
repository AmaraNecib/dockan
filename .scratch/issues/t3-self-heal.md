## Parent

#274

## What to build

A start that was refused because another copy held the data folder lets the owner in by itself, the moment that copy closes. No app restart, no file editing, no guessing when to press retry.

Why: the refusal instance starts a server and then never tries the folder again. Closing the other copy leaves the owner looking at a refusal and a retry button that cannot succeed until they quit and reopen the app — the one step they must be told about, and the one that keeps the support burden alive.

## Acceptance criteria

- [ ] A refused instance retries the reclaim with bounded backoff while it serves the refusal, and takes the folder when it becomes free.
- [ ] Once taken, it boots the app normally on the port it is already serving, without the owner restarting anything and without a second listener.
- [ ] While refused it writes nothing to the data folder — no vault file is opened, created or touched.
- [ ] While refused it never publishes or overwrites the owning instance's port record.
- [ ] The retry on the screen re-checks immediately rather than waiting for the next backoff tick, so a deliberate retry is never slower than the automatic one.
- [ ] A folder that stays held forever leaves the instance refusing quietly: no unbounded log growth, no CPU spin, and the refusal still names the holder.
- [ ] The reclaim attempt is bounded per tick, so retries can never race each other into two reclaims.
- [ ] Tests: the integration test that spawns a real second instance asserts the refused instance takes the folder after the holder is killed, with no restart; and the backoff is covered without sleeping for its full duration.

## Blocked by

- #275 — retrying a reclaim that cannot succeed is pointless, so the liveness fix lands first.
