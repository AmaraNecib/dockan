# Diagnose stale servers before changing a test

Seen in: #174, #130. Historical runs sometimes reached a server left by another
run. An isolated pass and a full-suite failure are symptoms, not proof of a stale
server, CPU contention or a pre-existing defect.

Identify the listener's process, command, checkout and owning run. Match the
server and data directory to the intended test tree. Use the supported stop
mechanism for a confirmed obsolete run; leave other owners' servers intact.
Choose isolated ports and data for concurrent runs under the current harness.
Preserve failing logs and artifacts before cleanup or retry.

A recovery-code typo test was historically attributed to checksum collisions.
That attribution does not classify a new failure. Capture the generated input,
expected result and actual parser outcome; inspect the current checksum code.
Use deterministic fixtures or a reproducible counterexample when repairing the
test. Retrying until green or weakening its assertion is not a diagnosis.

Use `guard` for required verification and the heavy-work queue for browser runs.
