# 13: Desktop packaging (installable Windows app)

**What to build:** the thing the owner actually installs — a Tauri window loading the built UI, the API running as a compiled sidecar `.exe`, app icons, produced as a portable NSIS installer that works on his Windows PC with no setup.

**Blocked by:** 02, 09, 10, 11, 12

**Status:** ready-for-agent

- [ ] `bun build --compile` produces the API sidecar; Tauri bundles and starts it on launch
- [ ] App icons exist and show in the installer/taskbar
- [ ] Portable NSIS installer builds and installs on a clean Windows PC
- [ ] Data, logs and backups live under the OS app-data directory, not the install folder
- [ ] Fresh-install smoke: login → first sale → backup file exists