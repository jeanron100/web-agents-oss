# Why Web Agents: features, use cases and alternatives

[English](comparison.md) | [简体中文](../comparison.md) · [Home](../../../README.en.md) · [Install](installation.md)

Web Agents fits a recurring workflow: you maintain projects on several Linux servers, run Codex, Kimi or Claude for development and operations, and need to check progress, add context and handle decisions from another device. Later, you need to find out what happened and why.

**Its main reason to exist is the combination of multi-node project management, an inbox for human decisions and execution evidence in one workflow.** Mobile access and multiple agents are also available in other good tools; neither is an exclusive advantage.

The feature baseline is v0.1.0-rc.11. Alternative-product documentation was checked on **2026-10-16**. This is a documentation-based selection guide, not an equivalent-environment performance, security or usability benchmark. Product capabilities and maintenance status can change; consult the linked official sources before adopting.

## What problems does it address?

| Problem | Approach | Practical benefit |
|---|---|---|
| Projects are scattered across machines | A Hub aggregates managed-node state, grouped by server or application | Find work that needs attention without checking every terminal |
| An agent is waiting for you while you are away | A shared inbox exposes approvals, questions, plans and changes awaiting review, depending on driver events | Handle human decisions from the browser |
| You need to clarify an active task | Codex supports immediate supplementation and a separate task queue | Send clarification now while keeping independent work separate |
| You remember assigning a task but not its outcome | Execution history and the project assistant retrieve requests, reports, methods and risks | Revisit the evidence behind an explanation |
| Another assistant needs project context | Eight bounded read-only stdio MCP tools query managed nodes and task evidence | Integrate context without copying transcripts repeatedly |
| Quota and consumption are hard to interpret | Account/window quota history and reset times are separate from CLI Token trends | Understand remaining windows and past work distribution |

## Delivered highlights and their conditions

**Multi-server management.** Add, edit, test, disable and remove nodes in settings. Nodes have independent tokens and project roots. The dashboard offers server/application views, stars, filters and project state. Your configured nodes define the scope. Removing a node does not stop its CLIs; network access, CLI installation and vendor authentication remain operator responsibilities. See [installation](installation.md).

**Multiple agents and mobile decisions.** View conversations, tool events and images; handle pending items, interrupt or resume supported sessions. Codex defaults to immediate supplementation, with queuing for independent tasks. Engine capabilities and CLI versions differ. Active native writers must not be bypassed by starting another writer. Automatic approval is still subject to the CLI's policy and sandbox.

**Evidence-backed progress.** Retrieve what was requested, what the execution record reports, how it was handled and what risks remain. An optional Chat Completions-compatible model helps plan queries and summarize evidence, retaining reported actual model, Token counts and compatibility warnings. A report saying “resolved” is not independent verification. Check sources, timestamps and coverage; missing evidence is not completion.

**Quota and consumption visibility.** Inspect quota windows/reset times, sampled quota history, daily Token trends and project consumption. Map shared accounts correctly across nodes. Token usage, including cached input, is not the same as subscription balance or an invoice. Missing quota samples remain gaps; independent account percentages are not added together.

**Read-only MCP.** External trusted tools can query managed servers/projects, pending items, sessions/events, history, progress and task evidence. They cannot execute commands, approve actions or change settings. The optional `history_search` projection requires MongoDB; default task evidence/progress uses MySQL and managed-node records. Read-only results may still be confidential. See [MCP integration](mcp.md).

**Files, terminals and versioned delivery.** Inspect screenshots, QR codes and task artifacts, or open a Web terminal. Releases include Linux amd64/arm64 images, source/image archives, checksums and Mac/Windows launchers. Mac/Windows run Linux containers through Docker Desktop; this does not adopt native desktop CLI processes. Replacing a runner stops its CLIs; preserve volumes and reload sessions. See [desktop delivery](desktop.md) and [operations](operations.md).

## Choosing between alternatives

The table describes each project's documented focus and a reasonable selection scenario. It does not treat unverified absences as disadvantages. Features, editions and licensing remain specific to each project.

| Official project | Documented focus | A reason to choose it | Where Web Agents fits |
|---|---|---|---|
| [Happy](https://github.com/slopus/happy#readme) | Multiple models using vendor subscriptions, mobile/desktop clients, end-to-end encrypted device synchronization and shared-session collaboration | Your priority is continuing sessions across devices, native clients or steering agents together | Evaluate Web Agents for multi-server project overview, pending decisions and evidence-backed progress; self-hosting alone does not establish stronger security than Happy's encryption |
| [HAPI](https://github.com/tiann/hapi#readme) | Wrapping official CLIs, local/remote handoff, mobile approvals, terminals, workspace browsing and a broad agent selection | You want a CLI-centered workflow that moves to your phone or broader agent support | Remote session control overlaps; Web Agents emphasizes the combination of multi-project management, history and read-only MCP, not exclusive Kimi or multi-agent support |
| [CloudCLI / Claude Code UI](https://github.com/siteboon/claudecodeui#readme) | Desktop/mobile Web UI, discovered sessions, file editing, Git, browser tasks and plugins; an additional hosted offering | You want a workspace-centered Web development environment with files, Git and extensions | Web Agents focuses on multi-node state, pending decisions and execution evidence while leaving your editor/Git workflow available |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban#readme) | Agent workspaces with branches, terminals/dev servers and diff review; its README also describes task-board workflows | Code-task organization, workspaces and reviewing changes are your priority | Web Agents manages existing server projects and execution records; equivalent automatic worktree/branch or PR delivery workflows are not shipped. Check its maintenance transition below |
| [OpenHands / Agent Canvas](https://github.com/OpenHands/OpenHands#readme) | Self-hosted agent control, ACP agents, local/remote/cloud backends, scheduled/webhook automations and external integrations | You want broader agent/backend extensibility or automated engineering workflows | Multiple backends are not exclusive to Web Agents. Its current focus is observing Linux CLI projects, human intervention, consumption and evidence retrieval rather than a general automation platform |

Vibe Kanban's official [April 10, 2026 announcement](https://www.vibekanban.com/blog/shutdown) says its company is shutting down, the project continues as open source/community-maintained, remote services are being withdrawn and local workspaces remain usable. README descriptions alone do not establish that historical hosted features are still offered; check the target version and community maintenance.

These projects overlap in multi-agent support, mobile access, self-hosting and execution backends. Web Agents offers an integrated workflow for **daily management and learning from work across multiple servers**. There is no verified claim here that it has the most features, best performance or strongest security.

## A complete example workflow

For a disk-space investigation, the intended path is:

1. Assign the task in the appropriate node/project. Observe its state and handle decisions in the inbox.
2. With Codex, add “do not delete business data; first check log-retention policy” to the active turn. Queue a separate follow-up task if needed.
3. Inspect the conversation, command records and artifacts, then verify the reported result and review changes.
4. Later, ask how the issue was handled and what risks remain. Check sources and historical coverage, returning to original records when necessary.
5. Query the same project evidence from a trusted MCP-connected tool for your own review or handover workflow.

This is a usage path, not a guarantee of task success or complete historical coverage.

## Suitability and remaining gaps

Choose Web Agents if you are one administrator or a trusted small team, operate Linux projects and want project oversight plus traceability. For a single local project, an existing editor/CLI and SSH/tmux may already be enough. Prioritize the alternatives above when native mobile collaboration, Git workspace review or general automation is the main requirement.

Not delivered: separate users/RBAC/project authorization, isolation between untrusted tenants, native Windows/macOS process adoption, native phone apps, equivalent automatic worktree/PR orchestration, and a complete visual upgrade/rollback/vendor-login wizard. Agent capabilities are not identical. Claude inference is not part of the current public vendor-account acceptance.

This is a release candidate without a production-support SLA. Self-hosting controls the console and execution environment; configured vendor CLIs and optional model services can still receive task content. It does not imply offline inference or an end-to-end encryption guarantee. See [security](../../../SECURITY.md), [release validation and roadmap](release-readiness.md), [third-party notices](third-party-notices.md) and [contributing](../../../CONTRIBUTING.md).
