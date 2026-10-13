# Customer identity is the phone number when present; existing invoices backfill by name

The `customers` and `suppliers` tables, the store methods and the contract already
exist but are unreachable (no router handlers), and every invoice stores only the
free-text `counterparty_name` with `counterparty_id` null. The debts page therefore
groups by typed name, so «علي علي» and «على علي» are two separate debtors and the
shop cannot answer "how much does this person owe me, and for what". We decided:

- A **phone number is the customer's identity when it is present**, and is unique
  across customer records. It stays optional, so a walk-in with no phone can still
  be saved; names may repeat. A duplicate-name warning in the picker catches the
  typo case before it creates a second debtor.
- The same rules apply to **suppliers**, because it is the same code path and the
  same duplicate problem pointing the other way («صالح بن علي» typed twice becomes
  two suppliers we owe).
- Existing invoices **backfill by name**: create a customer/supplier record per
  distinct typed name and set `counterparty_id` on the matching invoices.

Consequences worth remembering: SQLite treats NULLs as distinct, so the phone
uniqueness check lives in the store, not only in a schema constraint. Rows created
by mistake and still holding zero invoices can be hard-deleted; a record with
invoices cannot. Merge-duplicates and a printable account statement are explicitly
deferred — the picker prevents most duplicates at the source.
