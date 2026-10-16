# Web Agents v0.1.0-rc.11 — usable first login and public demo

- Redesigns the login and setup screens with consistent light/dark theme surfaces, readable labels and errors, responsive layout, theme switching and password visibility controls.
- Fresh container installations provide **admin / admin123**. The first sign-in is restricted to changing that temporary password; server-side authorization blocks project, settings, execution and terminal access until a new password of at least 12 characters is saved. Sign in again with the new password.
- Upgrades preserve existing credentials and unfinished token-based setup. Set `WA_INITIAL_ACCOUNT=0` before first start to opt into token-based manual setup. Native Hub installations keep that setup flow by default.
- Adds local `node server/manage.mjs reset-password` recovery. It preserves the username, resets a temporary password and revokes sessions; restart only the console to load the change, then set a new password.
- Documents initial credentials and recovery in the README and platform/operations guides. Adds links to the public demo, product overview and evidence-based alternative comparisons.
- Updates the public demo with Codex/Kimi/Claude examples, quota trends and a clearly labelled fictional task-evidence example; no real API, model or execution-node access.
- Extends first-use browser checks across themes and viewport sizes, and container acceptance covers initial sign-in, forced password change and rejection of the old password.

Download the corresponding Mac/Windows ZIP or Linux archive from this release. Docker Desktop is required for Mac/Windows. Existing installations remain pinned: update image references in `.compose.env` explicitly. No existing account is reset automatically. Published older versions are unchanged; production CLI processes are not migrated by this release.
