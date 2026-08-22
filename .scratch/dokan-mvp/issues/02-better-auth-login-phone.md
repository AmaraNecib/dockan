# 02: better-auth login (phone + password) + build-secret reset

**What to build:** the owner logs in with his phone number and a password; wrong credentials are refused; a forgotten password is repaired with the build secret baked into the app; a session keeps him logged in while the app is open; data screens are only reachable after login.

**Blocked by:** 01

**Status:** ready-for-agent

**GitHub:** #4

- [ ] Phone number is the unique login name, normalized to +213… (Algerian format), no email anywhere
- [ ] Password hashed (scrypt); wrong password / unknown phone refused with the same message
- [ ] Reset flow: entering the build secret sets a new password (logs a PASSWORD_RESET activity)
- [ ] Server-side session: RPC calls without a valid session are rejected
- [ ] UI: login screen + guard in Arabic (RTL)