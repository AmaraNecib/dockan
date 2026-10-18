---
name: capture-wisdom
description: "Read .agents/wisdom/**/*.md before starting a task; only the parent session writes them, and only when the same failure has occurred more than once. Lanes report lessons; they never write these files."
argument-hint: "What repeated lesson to capture, or what task you're starting that might benefit from past wisdom"
---

# Capture Wisdom

**Writing is parent-session only.** Every lane reads `.agents/wisdom/` before it
starts and reports which lessons it applied; no lane writes these files. A lane
puts a candidate lesson in its commit message body (a `Lesson:` line) and the
parent decides. The rule
exists because the opposite was measurable: lane-written lessons collided and the
owner resolved the same conflict by hand, and two lanes declined to record a
lesson because the write would have marked their own review evidence stale (the
numbers are in `AGENTS.md`, Authority).

Read `.agents/wisdom/**/*.md` at the start of any task. Write to them only when the
criterion below is met, and only from the parent session.

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
