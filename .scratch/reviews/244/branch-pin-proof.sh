#!/usr/bin/env bash
# #244 round 2 — every scanner branch must be pinned.
#
# Finding 4's rule ("deleting the reversed USE branch would leave the suite green")
# generalised: delete one matcher branch at a time and require the ratchet suite to
# REDDEN. A branch whose deletion stays green is a branch with no test that fails
# without it — i.e. edited, not fixed.
#
# Round 3 (Greptile finding 3): a non-zero exit is not a red suite. The untouched
# suite must be GREEN before the first deletion, and each deletion must produce at
# least one `(fail)` line — a crashed runner has no failing test to show.
#
# STATED CEILING: BRANCHES lists the ten matcher call sites only. The scanner's
# internals (`scanSource`'s template/`${}` region tracking, `withoutSubscripts`,
# the string-aware `breaksStatement`) are pinned by the fixture tests in
# `blankness-ratchet.test.ts`, not by a deletion here.
#
# The scanner is backed up to a mktemp copy and restored on EXIT (never git stash).
set -u
cd "$(dirname "$0")/../../.." || exit 1
SCANNER="apps/web/src/tests/blankness-gates.ts"

[ -z "$(git status --porcelain -- "$SCANNER")" ] || {
  echo "REFUSING: $SCANNER has uncommitted changes"
  exit 1
}

BACKUP="$(mktemp)"
OUT="$(mktemp)"
trap 'cp -p "$BACKUP" "$SCANNER"; rm -f "$BACKUP" "$OUT"' EXIT
cp -p "$SCANNER" "$BACKUP"
BEFORE="$(sha256sum "$SCANNER" | cut -d' ' -f1)"

# Green baseline first: a suite that is already red proves nothing about a deletion.
( cd apps/web && bun test src/lib/blankness-ratchet.test.ts > "$OUT" 2>&1 )
baseline=$?
if [ "$baseline" -ne 0 ]; then
  echo "FATAL: the ratchet is not green before any branch deletion"
  grep -E '\(fail\)|error' "$OUT" | head -10
  exit 1
fi
echo "baseline ratchet exit code: 0"

SCANNER="$SCANNER" BACKUP="$BACKUP" OUT="$OUT" python - <<'PY'
import io, os, re, subprocess

scanner = os.environ["SCANNER"]
original = io.open(os.environ["BACKUP"], encoding="utf-8").read()
out_path = os.environ["OUT"]

BRANCHES = [
    "INLINE_FWD",
    "PAREN_FWD",
    "PAREN_REV",
    "INLINE_REV",
    "INLINE_LEN",
    "INLINE_LEN_REV",
    "USE_FWD",
    "USE_LEN_FWD",
    "USE_REV",
    "USE_LEN_REV",
]

unpinned = []
crashed = []
for name in BRANCHES:
    pattern = re.compile(r"\n  claim(?:Inline|TwoStep)\(\s*" + name + r"\b.*?\);\n", re.S)
    match = pattern.search(original)
    if match is None:
        print(f"FATAL: no call site found for {name}")
        raise SystemExit(2)
    target = match.group(0)
    assert original.count(target) == 1, name
    with io.open(scanner, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(original.replace(target, "\n  ;\n"))

    with io.open(out_path, "w", encoding="utf-8") as sink:
        code = subprocess.run(
            ["bun", "test", "src/lib/blankness-ratchet.test.ts"],
            cwd="apps/web",
            stdout=sink,
            stderr=subprocess.STDOUT,
        ).returncode
    body = io.open(out_path, encoding="utf-8", errors="replace").read()
    fails = [line for line in body.splitlines() if line.startswith("(fail)")]
    print(f"--- delete {name}: exit {code}, {len(fails)} failing test(s)")
    for line in fails[:3]:
        print(f"    {line}")
    if code == 0:
        unpinned.append(name)
    elif not fails:
        crashed.append(name)

with io.open(scanner, "w", encoding="utf-8", newline="\n") as handle:
    handle.write(original)

if crashed:
    print(
        f"PROBLEM: deleting {', '.join(crashed)} exited non-zero with NO failing test "
        "— a crashed runner is not a detection"
    )
    raise SystemExit(1)
if unpinned:
    print(f"PROBLEM: branch deletion stayed green for {', '.join(unpinned)}")
    raise SystemExit(1)
print(f"branch-pin proof PASSED: all {len(BRANCHES)} branches redden the suite when deleted")
PY
result=$?

# The python pass rewrites the scanner as LF text; restore the exact backup bytes
# from the shell before the post-checks (the trap is the second line of defence).
cp -p "$BACKUP" "$SCANNER"

( cd apps/web && bun test src/lib/blankness-ratchet.test.ts > "$OUT" 2>&1 )
restored=$?
AFTER="$(sha256sum "$SCANNER" | cut -d' ' -f1)"
leftover="$(git status --porcelain -- "$SCANNER")"
echo "restored ratchet exit code: $restored"
if [ "$restored" -ne 0 ] || [ "$BEFORE" != "$AFTER" ] || [ -n "$leftover" ]; then
  echo "PROBLEM: did not restore $SCANNER exactly (bytes=$BEFORE->$AFTER leftover='$leftover')"
  exit 1
fi
echo "scanner restored byte-identical and green"
exit "$result"
