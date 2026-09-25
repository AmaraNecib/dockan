# Copilot Instructions — Dokan (دكان)

> This file contains **design and UX guidance** for AI assistants working in this repo.
> Engineering rules, business logic, and domain terms live in `AGENTS.md`, `CONTEXT.md`, and `docs/adr/`.

---

## Design Context

### Users

Shop owner running a car-accessories business in Algeria. Desk-based, daytime, well-lit shop. May use a shared shop computer. Needs speed, clarity, low cognitive load — professional tool used all day, not a product demo.

### Brand Personality

**Fast, practical, trustworthy.** Reliable professional shop tool. No playful, flashy, futuristic, or decorative aesthetics. SaaS landing-page energy is an anti-pattern.

### Aesthetic Direction

Modern professional POS / inventory / retail-management software. Efficient desktop workflows, information-dense but organized, strong hierarchy, fast data entry, clear tables and forms, minimal visual noise.

- **Theme**: Light mode primary/default. Dark mode acceptable if it doesn't sacrifice light-mode quality. No auto-switching without clear benefit.
- **Color**: Deep/medium blue as brand accent (trust, professionalism). Green for success only (not the brand color). Red for destructive/error. Amber for warnings. Neutral grays for structure. Tint neutrals toward blue hue. Avoid pure #000 and #fff.
- **Typography**: Arabic-first, RTL layout. Tajawal for Arabic. Clear heading/body hierarchy. LTR isolation for DZD amounts, dates, times, phone numbers, barcodes, invoice numbers, error codes. Tabular figures for numerical data.
- **Layout**: 4pt spacing scale, `gap` over margins, self-adjusting grids, container queries, varied spacing for hierarchy. Cap body text ~65-75ch.

### Design Principles

1. **Speed over decoration** — every pixel helps the owner work faster
2. **Information density done right** — dense but organized, clear hierarchy prevents overwhelm
3. **Trust through consistency** — predictable patterns, no surprises, reliable feedback
4. **Arabic-first, LTR-aware** — RTL default, LTR content properly isolated
5. **Accessible by default** — WCAG 2.2 AA baseline, not an afterthought

### Accessibility

WCAG 2.2 AA: sufficient contrast, visible focus states, keyboard navigation, clear labels, readable sizes, non-color-only status (icons + color + text), accessible forms/tables/dialogs, strong Arabic/RTL support with correct LTR isolation for numbers, dates, codes.
