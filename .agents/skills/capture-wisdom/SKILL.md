---
name: capture-wisdom
description: "Find task-relevant lessons in .agents/wisdom; parent-only maintenance after a repeated failure."
argument-hint: "Task area or repeated failure"
---

# Capture wisdom

1. Read `.agents/wisdom/README.md`. Search by task symbols or failure mode and
   read matching lessons, not the entire collection.
2. Check their assumptions against current source and policy. Apply only what
   fits. Workers report relevant lessons applied or excluded in their commit
   body and candidate lessons under `Lesson:`; they never edit wisdom.
3. The parent records a lesson only when the same failure recurred. Update the
   existing `<category>/<lesson>.md`; use no dates in filenames.
4. Keep the entry short: when it applies, what failed, the prevention step and
   `Seen in:` issue or PR references. Separate observations from hypotheses.
   Remove obsolete guidance instead of appending a contradictory correction.

Follow current workflow and guard requirements. A lesson cannot select review
models, waive a check, relabel old evidence or authorize stopping another task.
One occurrence stays in the handoff, not in wisdom.
