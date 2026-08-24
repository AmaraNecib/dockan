# RBAC reserved: wildcard permissions, admin owns `*`

Dokan keeps a single provisioned admin for the MVP (provisioned via the build secret,
enforced by the `adminUserId` setting). There is no username field anywhere: login is
phone number + password; names like `admin` are display-only labels and are never used
for authentication or authorization. We reserve the authorization model now so future
roles bolt on without reworking call sites:

- **Permissions are strings** in `domain:action` form (e.g. `stock:add`, `items:search`,
  `invoices:pay`). Domains mirror the contract prefixes (`stock`, `items`, `categories`,
  `invoices`, `parties`, `reports`, `settings`, `backup`, …).
- **Wildcards:** `*` grants every permission; `stock:*` grants every permission inside the
  stock domain. Matching is exact → domain wildcard → global wildcard, most specific wins.
- **Deny by default.** No matching permission means denied. Absence of a role, an empty
  permission list, or an unknown domain all fail closed. There is no implicit grant anywhere
  in the checker.
- **Roles map to permission lists** (admin → `["*"]`). New roles (cashier, counter) are just
  narrower lists — no code change to the checker, only data.
- **One enforcement seam.** When real RBAC lands, checks run through a single oRPC
  middleware (`requirePermission("stock:add")`) at the router boundary. Per-procedure
  permission logic scattered across handlers is not allowed.
- Until then, the existing single-admin session guard *is* the enforcement point; the
  middleware replaces it at the same seam when a second role arrives.

Status: accepted. Decided during ticket #28 planning;
RBAC implementation deferred to its own high-assurance ticket.
