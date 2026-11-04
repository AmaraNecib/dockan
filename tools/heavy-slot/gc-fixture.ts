/**
 * The grandchild fixture the cancel test (heavy-slot.test.ts [T2]) launches on
 * Windows. The wrapper shell `start /b`s this script and exits; the socket is
 * the observable "the grandchild is alive" without probing the wrapper's pid.
 *
 * ISSUE #342 evidence: two of these were still serving their sockets ~20 hours
 * after their test runs ended - the runner was killed outside run()'s cancel
 * path, which is the one cleanup path that knows about the tree, so the fixture
 * outlived every `finally` it had. Two self-owned death paths close that, and
 * neither weakens what the cancel test verifies:
 *
 * - the shutdown file: the fixture polls for this unique signal and exits when
 *   the launcher creates it. The pid file only records ownership; deleting it
 *   does not stop the fixture. The test's `finally` creates the shutdown file.
 * - the TTL: a killed runner runs no cleanup at all, so the fixture carries a
 *   clock of its own and is gone within the TTL no matter who forgot about it.
 *
 * The TTL the cancel test passes must stay far above that test's whole budget
 * (its cancel path has a 30 s window), so the TTL can never cut a live
 * observation short; it only bounds the lifetime a leak would have had.
 */
export type GcFixtureOptions = {
  /** Hard self-destruction at this age, so a killed runner can never strand it. */
  ttlMs?: number;
  /** Path the fixture writes its own pid to for ownership verification. */
  pidFile?: string;
  /** Unique cooperative shutdown file watched by this owned fixture. */
  shutdownFile?: string;
  /** Per-run response token so cleanup can prove this exact disposable fixture is alive. */
  ownershipToken?: string;
};

/** The fixture script: write the pid, bind the socket, die by signal-file or clock. */
export function buildGcFixtureScript(port: number, options: GcFixtureOptions = {}): string {
  const pidFile = options.pidFile ?? "";
  const shutdownFile = options.shutdownFile ?? "";
  const ttl = options.ttlMs ?? 0;
  const ownershipToken = options.ownershipToken ?? "";
  return [
    'import net from "node:net";',
    'import { existsSync, writeFileSync } from "node:fs";',
    `const pidFile = ${JSON.stringify(pidFile)};`,
    `const shutdownFile = ${JSON.stringify(shutdownFile)};`,
    `const ownershipToken = ${JSON.stringify(ownershipToken)};`,
    // The launcher's handle on the grandchild: its pid, on disk, written before
    // the socket binds so a delete that races the launch still finds a file.
    'if (pidFile) writeFileSync(pidFile, `${process.pid}\\n`);',
    'if (shutdownFile) { // cooperative signal addressed to this fixture',
    "  const watch = setInterval(() => {",
    "    if (existsSync(shutdownFile)) { clearInterval(watch); process.exit(0); }",
    "  }, 50);",
    "}",
    ...(ttl > 0
      ? [
          `// The TTL bounds what a killed runner could strand; ${ttl}ms is far beyond the cancel test's budget.`,
          `setTimeout(() => process.exit(0), ${ttl});`,
        ]
      : []),
    `net.createServer((socket) => socket.end(ownershipToken)).listen(${port}, "127.0.0.1");`,
    "// no exit: the socket keeps the event loop running, that IS the pin",
  ].join("\n") + "\n";
}
