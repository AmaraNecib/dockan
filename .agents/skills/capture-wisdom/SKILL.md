---
name: capture-wisdom
description: "Read and write .agents/wisdom/*.md files. Use at start of a task (read wisdom), after solving a bug (write wisdom), at end of a session (write wisdom)."
argument-hint: "What lesson to capture or what task you're starting that might benefit from past wisdom"
---

# Capture Wisdom

Read `.agents/wisdom/*.md` at the start of any task. Write to them when
you learn something worth remembering.

## When to write

- A CodeRabbit finding surprised you
- A bug took more than 15 minutes to diagnose
- An adversarial review found a real issue
- You notice the same issue across multiple PRs
- You're about to end a session

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
