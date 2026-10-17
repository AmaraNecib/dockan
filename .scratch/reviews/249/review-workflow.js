const base = "ad8445f";
const common =
  "Work read-only in D:/projects/mani-worktrees/issue-249-ast-walk (a git worktree on branch issue-249-ast-walk). " +
  `Run \`git diff ${base}...HEAD\` and \`git log ${base}..HEAD --oneline\` first. ` +
  "Read the full changed files apps/web/src/tests/blankness-gates.ts and apps/web/src/lib/blankness-ratchet.test.ts. " +
  "Read the spec D:/projects/mani-project/.scratch/sessions/crew/briefs/issue-249-ast-walk.md and " +
  "D:/projects/mani-worktrees/issue-249-ast-walk/.scratch/implementation/249-design.md. " +
  "The change replaces a regex scanner with a ts.createSourceFile() AST walk; the interface (findBlanknessGates, " +
  "numericReaderFiles, scanNumericDraftReaders, BlanknessGate, signature strings) must be unchanged. " +
  "Evidence already produced: gate-set-diff ADDED []/REMOVED [] at 32 gates; 46 ratchet tests green; " +
  "8 new fixtures red against the old scanner; a 13-branch AST deletion proof; the #244 mutation proof green; " +
  "typecheck/lint/full unit suite green.";

const tasks = [
  {
    key: "critic",
    agent: "reviewer",
    task:
      "You are a HARSH CRITIC. " +
      common +
      " Find every flaw, risk, over-engineering, missing edge case and design problem. " +
      "Focus on: (1) can the AST walk MISS a raw-.trim() blankness gate that the regex caught? " +
      "(2) can it FALSELY report a gate, or REFUSE a legitimate production shape? " +
      "(3) does the fail-closed contract (BlanknessScanError) have holes -- what node shape still slips silently? " +
      "(4) is the two-step declaration scope resolution correct under shadowing/hoisting? " +
      "(5) can a signature string drift from CLASSIFIED? " +
      "(6) is the private-field fixture source change (comment inside a private name is invalid TS) acceptable? " +
      "Score each finding 1-10 (10 = must-fix blocker), with file:line and explanation. Test quality is audited separately. Under 700 words.",
  },
  {
    key: "defender",
    agent: "reviewer",
    task:
      "You are a CHARITABLE DEFENDER. " +
      common +
      " Argue FOR the implementation: what it does right, which complexity is justified, why the AST approach ends the " +
      "round-1..4 lexing class of failure, why fail-closed is the correct trade, and why the ceilings are honestly stated. " +
      "Cite file paths and line numbers. Give a confidence score 1-10 for each defense. Under 600 words.",
  },
  {
    key: "test-audit",
    agent: "reviewer",
    task:
      "You are a TEST AUDIT covering three lenses: EDGE CASE HUNTER, COVERAGE ANALYST, TEST QUALITY REVIEWER. " +
      common +
      " Audit apps/web/src/lib/blankness-ratchet.test.ts (the #244 describe and the new #249 describe). " +
      "1. EDGE: name missing cases for the AST walk (empty input, comment-only, CRLF, unicode, optional chaining, " +
      "nested scopes, declaration shadowing, `?.length`, `??` receivers, normaliser variants). Rate each red/orange/yellow " +
      "and give a test snippet. 2. COVERAGE: does every acceptance criterion in the brief have a test? any duplicate/shallow " +
      "coverage? 3. QUALITY: test names, isolation, assertion quality; grade A-D. Under 700 words.",
  },
  {
    key: "code-review",
    agent: "reviewer",
    task:
      "Run a two-axis code review and report under '## Standards' and '## Spec' headings, separately. " +
      common +
      " STANDARDS axis: read tsconfig.base.json, docs/engineering-workflow.md, AGENTS.md and any repo coding standards; " +
      "report documented-standard violations (cite the rule) and Fowler baseline smells (Mysterious Name, Duplicated Code, " +
      "Primitive Obsession, Repeated Switches, Speculative Generality, Middle Man, etc.) as judgement calls. " +
      "Skip anything oxlint/tsc already enforces. " +
      "SPEC axis: compare the diff against the brief D:/projects/mani-project/.scratch/sessions/crew/briefs/issue-249-ast-walk.md; " +
      "report (a) requirements missing/partial, (b) behaviour not asked for, (c) requirements implemented wrongly, quoting the spec line. " +
      "End with one line: total findings per axis and the worst issue within each axis. Under 700 words.",
  },
];

const results = await runs.all(tasks);
return results.map((result, index) => `===== ${tasks[index].key} =====\n${result.output}`);
