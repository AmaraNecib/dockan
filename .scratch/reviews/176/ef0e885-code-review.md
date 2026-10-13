# Code review — issue #176 supplier adjustments

Reviewed SHA: `ef0e885` (base `1840a3a`). Two axes, separate reviewers, in two
rounds.

## Standards

Round 1 found no hard documented-standard violations. Judgement-call smells:

- The ADJUSTMENT sign is re-derived in the pure module, the SQL helper, and two
  web spots. The SQL helper is shared and the pure/SQL pair is covered by an
  agreement test, so this is a documented tradeoff rather than accidental
  duplication.
- `SupplierOpeningBalancePage` is a long component (table + dialog + mutation);
  extracting subcomponents is a future readability improvement.
- Round-1 concrete items fixed in round 2: duplicate `supplier-adjust-preview`
  testid, unused `supplierOpeningAmountRequired` i18n key.

Round 3 (final): **no documented-standard violation, no baseline smell beyond
the minor schema-guard note below.**

Minor note: the fresh DDL enforces `ADJUSTMENT ⇒ direction NOT NULL` but not the
converse (a direction on a non-ADJUSTMENT kind is schema-legal). The store seam
plus the contract keep the pairing honest, and the ALTER path cannot carry a
table-level CHECK.

## Spec

Every scope item is implemented and tested:

1. Additive ADJUSTMENT kind with a WE_OWE/THEY_OWE direction, amount, reason,
   date; append-only (no update/delete path).
2. Optional invoice link: account-only never touches an invoice; invoice-linked
   reduces that purchase invoice's remaining with the returns' conditional
   UPDATE, clamped at ≥ 0, excess refused (`ADJUSTMENT_EXCEEDS_REMAINING`), and
   `returnCreditAmount` updated so the header reconciles.
3. «تسوية» on the supplier detail page with direction, amount, reason + presets
   (رصيد افتتاحي / تصحيح / دين قديم / خصم), a backdatable date, and the optional
   «تخصّ فاتورة؟» picker.
4. Bulk «رصيد افتتاحي» screen: name + current balance per supplier, direction +
   amount per row, inline new supplier or an existing row, one shared date +
   reason, confirmation for a supplier that already carries an entry, one
   account-only تسوية per filled row (no invoice link).
5. Money rules: `BEGIN IMMEDIATE`, conditional UPDATEs, no check-then-act;
   «دفعة» untouched as the paid-money tool; no existing invariant weakened.
6. **Blocking** v2 → v3 migration test present and green.
7. CONTEXT.md terms (تسوية / نسالوه / يسالنا) and ADR-0010 (adjustment model,
   optional invoice link, additive customer-extension path).

Round 1 wrong-behaviour findings fixed: negative balance clamped to 0; inert
stale-expectation confirmation. Round 3 final: **no spec gap, no scope creep, no
implemented-but-wrong item.**

## Deferred (non-blocking)

- Server-side duplicate-name refusal in the bulk endpoint (client-side today,
  because ADR-0007 permits duplicate names). Proposed follow-up issue.
- A store-seam assertion that an `invoice_id`-bearing ADJUSTMENT is `THEY_OWE`.
- Splitting `SupplierOpeningBalancePage` into table/dialog subcomponents.
