# Isolated ports do not prove why a vault run timed out

Seen in: #206 and #129.

Historical concurrent vault runs reached slow reset-passphrase requests despite
disjoint ports. Key derivation was a plausible source of contention; a pending
request alone does not prove CPU starvation or exclude a regression.

Verify server and data-directory ownership first. A healthy status endpoint or
create-vault heading does not prove that separate runs use separate vaults.
Exercise each run's own create, restart and recovery flow when testing isolation.

For a timeout, preserve request timings, server logs, host load and the tested
tree. Attribute the delay before changing timeouts or code. Run heavy checks
through the queue and report failures as failures until diagnosed.
