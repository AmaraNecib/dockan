---
name: capture-wisdom
description: "Parent-session only: read and write .agents/wisdom/*.md when the same failure has occurred more than once. Lanes report lessons; they never write these files."
argument-hint: "What repeated lesson to capture, or what task you're starting that might benefit from past wisdom"
---

# Capture Wisdom

**Parent session only.** A lane never writes `.agents/wisdom/` — it puts the
lesson in its `crew_report` and lets the parent decide. The rule exists because
the opposite was measurable: 45 commits on `develop` touch `.agents/wisdom/`, six
files carry edits from more than one commit, and the owner resolved the same
conflict by hand, while two lanes declined to record a lesson at all because the
write would have marked their own review evidence stale.

Read `.agents/wisdom/*.md` at the start of any task. Every lane does the same and
reports which lessons it applied; wisdom is read-only for a lane, and the file is
written only from the parent session. Write to them only when the criterion below
is met.

## When to write

**The same failure has occurred more than once.** One occurrence is a report
line, not wisdom. The parent is the only one who sees several lanes' reports, so
the parent is the only one who can tell the difference.

- The same failure appeared in two or more lanes' reports or PRs
- A bug took more than 15 minutes to diagnose and recurred
- An adversarial review found the same real issue twice
- A CodeRabbit/Greptile finding surprised you twice

## File conventions

| File | What goes in it |
|------|----------------|
| `process.md` | Workflow, tooling, CI, PR conventions, Greptile + CodeRabbit driving, review process |
| `security.md` | Security patterns, vulnerabilities, contract violations |
| `testing.md` | Test patterns, common mistakes, coverage advice |
| `architecture.md` | Design decisions, module boundaries |

## Severity labels

- 🔴 **Critical** — Must-fix, incorrect behavior
- 🟠 **Major** — Should fix, causes confusion
- 🟡 **Minor** — Good to know
- 💡 **Design Principle** — Architectural guidance

## Format

```markdown
## Finding title (🔴 Severity)

What happened, with enough context for a future agent.

**Always**: What to do next time. Be specific.
```
