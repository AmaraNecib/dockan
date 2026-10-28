# Diagrams in review summaries

Keep summary.diagram optional in the payload format so a reviewer can report honestly when no accurate diagram can be made. Include a diagram whenever the reviewed change can be represented accurately, even when it repeats the text summary. Prefer a small diagram of control flow, data flow, state transitions or interaction order. A simple before/after relationship is also valid for a mechanical change. Show the changed behavior, not a generic development lifecycle.

Omit the field only when the reviewer cannot produce an accurate, meaningful diagram from the pinned code. Record a brief omission reason in summary.checks. Summary overlap, a small diff or a mechanical change alone is not a reason to omit it. Verify the contents rather than inventing relationships to fill a section.

Verify every node and edge against the pinned code before publishing. Name real modules, states or operations. Use a flowchart for branches or data flow, a sequence diagram for call order, or a state diagram for transitions. Put Mermaid source only in summary.diagram, without the outer Markdown fence; the renderer supplies the Diagram section and mermaid fence. Diagram presence does not change the confidence score. The parent checks that it is supplied whenever feasible or that the omission reason explains why it cannot be drawn accurately.

## Default review presentation

The renderer makes Summary and Diagram independently collapsible and open by default. The confidence score and verdict remain visible outside them. Findings include every verified severity, including P2, with fix prompts in the summary and inline comments whenever findings exist. This is fixed default behavior, not a hosted settings page or a new configuration API.

Keep the reviewloop status check enabled and require 5/5 for a pass. A Greptile settings screenshot with confidence threshold zero does not override the repository's merge gate. During the paired trial, read Greptile's actual score separately even when its check is green. Collapsing a section changes presentation only, never the evidence or pass criteria.

## Historical examples

A sample of the 15 most recently updated closed PRs had three summaries with diagrams and twelve without. These were final comment snapshots from GitHub, not per-round edit history. The sample is not a diagram-selection algorithm. PR titles and summaries supplied scope descriptions; this sample did not independently verify their diffs.

- [#368](https://github.com/AmaraNecib/dockan/pull/368#issuecomment-6354935034) shows branching failure classification for hollow versus appended stand-ins.
- [#358](https://github.com/AmaraNecib/dockan/pull/358#issuecomment-6348870418) shows the heavy queue's claim, run, release, retry and refusal branches.
- [#360](https://github.com/AmaraNecib/dockan/pull/360#issuecomment-6348958602) shows typed-name normalization through grouping, comparison, debt and refund reads.
- [#417](https://github.com/AmaraNecib/dockan/pull/417#issuecomment-6457386736) has no diagram for a UI positioning fix. [#366](https://github.com/AmaraNecib/dockan/pull/366#issuecomment-6354362846) has none for a test quarantine.
- [#370](https://github.com/AmaraNecib/dockan/pull/370#issuecomment-6355715293) also has no diagram despite shared money-query refactoring. A category or file count alone is not a reliable trigger.

The inclusion rule above follows the owner's preference to include any accurate diagram, even if it overlaps the summary. It deliberately differs from the observed optional use and is not a claim to reproduce Greptile's hidden selection rules.
