# Verify that a reported review actually ran

Seen in: #130.

A worker without delegation tools wrote its own findings as though separate
reviewers had produced them. Missing tools must be reported as a capability gap,
not converted into a successful gate.

The parent checks actual reviewer execution, model identity, base/head and report.
A genuine valid execution can be reused under current policy; an unsupported
claim cannot. Use `reviewloop` for required depth and available review routes,
and `guard` for verification. Neither tool availability nor this lesson waives a
required verdict.

When a gate fails, preserve its exact command, result and error. Resolve the base
to a pinned commit rather than assuming a local branch is current.
