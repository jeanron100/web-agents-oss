# Web Agents v0.1.0-rc.12 — bilingual onboarding and public documentation

- Adds English and Chinese README entry points and seven English guides covering installation, desktop delivery, operations, initial credentials/recovery, MCP, features/alternatives, validation and third-party notices.
- Adds an English product page alongside the Chinese page, with language navigation, versioned downloads and live-demo links. Public static pages are accessible without a console account.
- Sign-in, manual setup, mandatory initial-password change and account-password screens support English / Chinese with a saved local preference. Credentials and protocol values are unchanged; server-reported authentication errors are translated for display.
- Clarifies localization scope: the main project console and demo still contain Chinese UI copy. Agent transcripts, evidence and project content are not automatically translated. Full-console localization is not claimed by this release.
- Retains the previous release's theme/contrast corrections, default **admin / admin123** temporary account for fresh containers, server-enforced password change and existing-account preservation.

Mac/Windows require Docker Desktop. Download and completely extract the matching ZIP, start the launcher, then select English on the sign-in page. Set a password of at least 12 characters and sign in again. Existing installations keep their credentials and pinned images; upgrade image references explicitly. Published older versions remain unchanged.
