#!/usr/bin/env bash
# #249 — every AST detection branch must be pinned.
#
# The regex scanner's `branch-pin-proof.sh` deleted one matcher call site at a
# time (INLINE_FWD, USE_LEN_REV, ...). Those call sites no longer exist; this is
# the AST walk's replacement. It deletes the detection of one node KIND at a time
# and requires the ratchet suite to REDDEN with at least one `(fail)` line: a
# branch whose deletion stays green is a branch no test fails without, i.e.
# edited, not fixed.
#
# A non-zero exit is not a red suite: the untouched suite must be GREEN before the
# first deletion, each deletion must produce a `(fail)` line, and the scanner must
# be restored byte-identical afterwards.
#
# Never `git stash` (a path-scoped stash with nothing to stash pops an unrelated
# one): the scanner is backed up to a mktemp copy and restored on EXIT.
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
import io, os, subprocess

scanner = os.environ["SCANNER"]
original = io.open(os.environ["BACKUP"], encoding="utf-8").read()
out_path = os.environ["OUT"]

# (name, exact source, replacement). The replacement disables one detection
# branch without touching the others, so a red run is attributable to it.
#
# Every `old` MUST occur exactly ONCE. An `old` that matches several sites would
# delete them together, so one covered branch would let the whole group read
# green while another is never exercised (Greptile #251 finding 3: the
# truthiness-refusal call appeared at seven positions and the old proof replaced
# all seven at once). The `ambiguous` check below enforces the uniqueness.
BRANCHES = [
    # detection
    ("inline trim call", "if (isTrimCall(expression)) {", "if (false) {"),
    ("two-step string binding", "if (!ts.isIdentifier(expression)) return;", "if (true) return;"),
    ("inline length of trim", "if (isTrimCall(on)) {", "if (false) {"),
    ("two-step length binding", "if (!ts.isIdentifier(on)) return;", "if (true) return;"),
    ("declaration collection", "if (trim !== undefined) {", "if (false) {"),
    (
        "trim default fallback",
        "if (isTrimCall(left) && (isEmptyString(right) || isEmptyTemplate(right))) return left;",
        "return undefined;",
    ),
    ("normaliser skip", "return ts.isIdentifier(callee) && NORMALISERS.has(callee.text);", "return false;"),
    (
        "normaliser-call guard",
        "if (!ts.isCallExpression(receiver) || receiver.arguments.length === 0) return false;",
        "if (true) return false;",
    ),
    # classified blank operands
    ("left blank operand", "if (isEmptyString(left)) {", "if (false) {"),
    ("right blank operand", "} else if (isEmptyString(right)) {", "} else if (false) {"),
    ("zero operand", "} else if (isZero(left)) {", "} else if (false) {"),
    # refusal — ONE entry per source position
    ("relational refusal", 'refuse(comparison, "relational test on a raw .trim()");', ";"),
    ("empty-template refusal", 'refuse(comparison, "empty template literal operand");', ";"),
    (
        "truthiness refusal (&& / ||)",
        "if (kind === ts.SyntaxKind.AmpersandAmpersandToken || kind === ts.SyntaxKind.BarBarToken) {",
        "if (false) {",
    ),
    (
        "truthiness refusal (prefix !)",
        "if (ts.isPrefixUnaryExpression(owner) && owner.operator === ts.SyntaxKind.ExclamationToken) {",
        "if (false) {",
    ),
    (
        "truthiness refusal (ternary)",
        "if (ts.isConditionalExpression(owner) && isAncestor(owner.condition, node)) {",
        "if (false) {",
    ),
    ("truthiness refusal (if)", "if (ts.isIfStatement(owner) && isAncestor(owner.expression, node)) {", "if (false) {"),
    (
        "truthiness refusal (while)",
        "if (ts.isWhileStatement(owner) && isAncestor(owner.expression, node)) {",
        "if (false) {",
    ),
    ("truthiness refusal (do)", "if (ts.isDoStatement(owner) && isAncestor(owner.expression, node)) {", "if (false) {"),
    (
        "truthiness refusal (for)",
        "if (ts.isForStatement(owner) && owner.condition !== undefined && isAncestor(owner.condition, node)) {",
        "if (false) {",
    ),
    (
        "length truthiness refusal",
        "if (isLengthAccess(node) && isRawTrimExpression(node, node)) refuseIfTestPosition(node);",
        ";",
    ),
    (
        "bound truthiness refusal",
        "if (declaration !== undefined && !declaration.normalised) refuseIfTestPosition(node);",
        ";",
    ),
]

unpinned = []
crashed = []
missing = []
ambiguous = []
for name, old, new in BRANCHES:
    count = original.count(old)
    if count == 0:
        missing.append(name)
        continue
    if count > 1:
        ambiguous.append(name)
        continue
    with io.open(scanner, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(original.replace(old, new))

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

if missing:
    print(f"FATAL: no source found for {', '.join(missing)}")
    raise SystemExit(2)
if ambiguous:
    print(
        f"FATAL: {', '.join(ambiguous)} match more than one source site "
        "- a shared deletion hides an unpinned branch"
    )
    raise SystemExit(2)
if crashed:
    print(
        f"PROBLEM: deleting {', '.join(crashed)} exited non-zero with NO failing test "
        "- a crashed runner is not a detection"
    )
    raise SystemExit(1)
if unpinned:
    print(f"PROBLEM: branch deletion stayed green for {', '.join(unpinned)}")
    raise SystemExit(1)
print(f"AST branch-pin proof PASSED: all {len(BRANCHES)} branches redden the suite when deleted")
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
