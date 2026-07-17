# Boolean capability platform

Boolean now exposes one zero-dependency platform layer for advanced agent work.
The same approval, project, checkpoint, and connector contracts are shared by
all capabilities instead of building separate agent systems.

## Implemented locally

| Area | Boolean capability |
| --- | --- |
| Parallel agents | Up to three focused agents can run together. Git projects support isolated branches and worktrees, durable result records, selective apply, and discard. |
| GitHub workflows | Authenticated `gh` operations cover repository status, issues, pull requests, diffs, checks, failed run logs, comments, and approved PR creation. |
| Review and security | Deterministic source review returns severity plus file-and-line evidence for common secret, execution, HTML, TLS, and exception risks. |
| Skills and hooks | Local versioned `skill.json` packages support declared instructions, permissions, install, inspect, activate, remove, and approved event hooks. |
| Scheduled automation | Notepad selections and Settings create durable one-time, daily, weekly, or monthly reminders, answer-only AI follow-ups, page opens, commands, and HTTPS webhooks. Tasks persist across restarts, run while Boolean is open, catch up after launch, and retain bounded run history. |
| Documents | Boolean creates structurally verified DOCX, XLSX, PPTX, and PDF files without runtime dependencies. |
| Images | A configured OpenAI-compatible image provider can generate or edit images, save them into a project, and attach a local preview. Provider, model, and output size are selected under Settings > Creation & research. Provider charges may apply. |
| Current research | Boolean searches in the background, ranks official, primary, government, academic, and first-party documentation sources before weaker sources, reads the strongest pages, and returns numbered evidence with direct citation URLs. |
| Connected services | Existing email, MCP, HTTP agent, visible-browser, and GitHub adapters are available to the same tool loop. Additional services can arrive as connectors or skills. |
| Isolated execution | Commands can run in a disposable copied workspace with timeout, output limits, and network-capable commands blocked by default. |
| Reliability | Durable task checkpoints, unlimited productive tool turns, repeated-action protection, local/cloud recovery, and isolated agent result records remain active. |

## Safety and current boundaries

- Mutating GitHub operations, skill installation/hooks, automation creation,
  artifact writes, image provider calls, and guarded commands require approval.
- Guarded execution is filesystem isolation, not a hardened VM or security
  boundary. Strong isolation still requires a dedicated sandbox runtime.
- Office and PDF verification currently checks package/file structure. Visual
  rendering and pixel-level review are a future artifact-worker enhancement.
- GitHub workflows require the GitHub CLI to be installed and authenticated.
- Image operations require a compatible user-supplied API key and endpoint.
- Google Workspace, Microsoft 365, and other services require their connector,
  OAuth setup, or a compatible MCP/skill; Boolean does not silently gain access.
- Skill packages are local and permission-declared, but are not yet signed.

## Next product work

1. Add first-class Settings pages for skills and GitHub.
2. Add render-and-visual verification workers for Word, Excel, PowerPoint, PDF,
   and generated images.
3. Replace copied-workspace execution with a hardened sandbox service where
   untrusted public code must be executed.
4. Add signed skill packages, update feeds, connector scopes, retry policies,
   richer Windows notifications, model budgets, and per-run cancellation controls.

Every enhancement must preserve Local mode, user-owned API keys, explicit
approval for meaningful writes, and interrupted-task recovery after restart.
