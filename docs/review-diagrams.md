# Diagrams in review summaries

Keep summary.diagram optional. Include one small Mermaid diagram when control flow, data flow, state transitions or interaction order in the reviewed change is easier to understand as relationships than as prose. Show the changed behavior, not a generic development lifecycle.

Omit the field when a diagram would only restate a sentence, invent relationships, or decorate a mechanical change such as a dependency pin, CSS adjustment or test quarantine. A large diff, a security label or a high impact rating does not by itself justify a diagram. Record a brief omission reason in summary.checks so the parent can distinguish a deliberate choice from a forgotten field.

Verify every node and edge against the pinned code before publishing. Name real modules, states or operations. Use a flowchart for branches or data flow, a sequence diagram for call order, or a state diagram for transitions. Put Mermaid source only in summary.diagram, without the outer Markdown fence; the renderer supplies the Diagram section and mermaid fence. Leave it absent when it adds no information. No score or merge requirement depends on diagram presence.

## Historical examples

A sample of the 15 most recently updated closed PRs had three summaries with diagrams and twelve without. These were final comment snapshots from GitHub, not per-round edit history. The sample is not a diagram-selection algorithm. PR titles and summaries supplied scope descriptions; this sample did not independently verify their diffs.

- [#368](https://github.com/AmaraNecib/dockan/pull/368#issuecomment-6354935034) shows branching failure classification for hollow versus appended stand-ins.
- [#358](https://github.com/AmaraNecib/dockan/pull/358#issuecomment-6348870418) shows the heavy queue's claim, run, release, retry and refusal branches.
- [#360](https://github.com/AmaraNecib/dockan/pull/360#issuecomment-6348958602) shows typed-name normalization through grouping, comparison, debt and refund reads.
- [#417](https://github.com/AmaraNecib/dockan/pull/417#issuecomment-6457386736) has no diagram for a UI positioning fix. [#366](https://github.com/AmaraNecib/dockan/pull/366#issuecomment-6354362846) has none for a test quarantine.
- [#370](https://github.com/AmaraNecib/dockan/pull/370#issuecomment-6355715293) also has no diagram despite shared money-query refactoring. A category or file count alone is not a reliable trigger.

The inclusion rule above is our policy based on usefulness, not a claim to reproduce Greptile's hidden selection rules.
