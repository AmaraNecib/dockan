## Parent

#274

## What to build

When another copy of Dokan holds the data folder, the app says exactly that, in the owner's words, with a retry that has a real chance of working — instead of claiming the server is not running. A genuinely unreachable server keeps its current message, so the honest one does not get watered down.

Why now: the refuser answers the status route with `503` and an HTML page, and the web maps every non-OK response to the unreachable failure. The owner is told to start a server that is already answering. The translated copy for the real cause already exists (`VAULT_LOCKED_BY_OTHER_INSTANCE`) and nothing reads it.

## Acceptance criteria

- [ ] The refusal answers the JSON route the app actually calls with `503` and the code `VAULT_LOCKED_BY_OTHER_INSTANCE`, matching what `/health` already answers. The client parses no HTML.
- [ ] The web gains a distinct failure for that code; it no longer collapses into the unreachable failure.
- [ ] The refusal screen shows the existing translated copy for `VAULT_LOCKED_BY_OTHER_INSTANCE` (البيانات مفتوحة في نسخة أخرى من دكان على هذا المجلد. أغلق النسخة الأخرى ثم أعد فتح التطبيق.) and offers retry.
- [ ] The server-down copy (تعذّر الاتصال بالخادم. تأكد من تشغيله ثم أعد المحاولة.) is not shown for a refusal — and is still shown when the server is genuinely unreachable.
- [ ] A legacy build's `404` still reaches the legacy login path, unchanged.
- [ ] No new contract code and no new i18n key: the vocabulary and the strings already exist.
- [ ] Tests: the vault client's units for refusal-vs-unreachable-vs-legacy, and the session-gate component test asserting the in-use screen appears for a refusal and the server-down screen does not.

## Blocked by

None (can start immediately), but it shares the refusal route with #275, which lands first — rebase onto it.
