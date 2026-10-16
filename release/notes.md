# Web Agents v0.1.0-rc.10 — release identity and model observability

- `/api/health` now reports the exact release, including the RC suffix, plus the matching `releaseTag`. Release preflight and real container smoke tests reject mismatches.
- The project assistant preserves actual gateway-resolved model/provider, reported input/output/total/cache/reasoning tokens, request IDs and compatibility warnings for planning and synthesis calls.
- Ignored parameters such as `max_tokens` are visibly flagged. Missing usage remains unknown; failed structured answers retain completed-call information. Repeated polling does not duplicate calls.
- Read-only MCP retains bounded model metadata within its full response byte budget. Raw gateway/config fields and credentials are excluded.
- Adds actual-container adapter acceptance with an isolated mock gateway, plus backend/frontend regression checks. The existing Mac/Windows bundles and amd64/arm64 images remain available.

Download the OS ZIP from this version, extract it, and run the desktop launcher with Docker Desktop started. Existing installations remain pinned; explicitly upgrade the images in `.compose.env`. Published older versions remain unchanged. Trusted single-administrator/team deployment; vendor accounts are your own. Physical desktop Docker Desktop GUI acceptance is not claimed.
