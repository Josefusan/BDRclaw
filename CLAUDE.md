# BDRclaw

AI-native BDR team built on NanoClaw. See [README.md](README.md) for overview and setup. See [docs/SPEC.md](docs/SPEC.md) for full architecture and data model.

## Quick Context

Single Node.js process with skill-based channel system. Channels (Gmail, LinkedIn, Twilio SMS, Slack, WhatsApp, Telegram, Discord) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each prospect has isolated filesystem and memory via `prospects/*/CLAUDE.md`.

The BDR Brain agent (`src/bdr-brain.ts`) runs on a daily schedule to review the pipeline, classify replies, detect buying signals, and queue follow-up actions.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/prospect-queue.ts` | Per-prospect queue with global concurrency limit |
| `src/container-runner.ts` | Spawns streaming agent containers |
| `src/task-scheduler.ts` | Runs scheduled BDR tasks (daily brain, follow-ups) |
| `src/bdr-brain.ts` | Daily pipeline review, action queuing, signal detection |
| `src/db.ts` | SQLite operations (prospects, messages, tasks, sessions) |
| `prospects/*/CLAUDE.md` | Per-prospect memory (isolated) |
| `groups/*/CLAUDE.md` | Per-channel group memory |
| `groups/*/sequences/*.md` | Outreach sequence definitions |
| `container/skills/` | Skills loaded inside agent containers |
| `docs/SPEC.md` | Full architecture and data model spec |

## Skills

Four types of skills exist in BDRclaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-linkedin`, `/add-hubspot`)
- **Utility skills** — ship code files alongside SKILL.md
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

### Available Channel/Integration Skills

| Skill | Description |
|-------|-------------|
| `/add-gmail` | Cold email sequences + reply detection |
| `/add-linkedin` | LinkedIn prospecting + DM sequences |
| `/add-hubspot` | CRM sync, stage updates, contact creation |
| `/add-attio` | Attio CRM integration |
| `/add-apollo` | Contact enrichment + email finding |
| `/add-twilio` | SMS outreach |
| `/add-slack-outreach` | Slack Connect SDR sequences |
| `/add-whatsapp` | WhatsApp outreach channel |
| `/add-calendly` | Meeting link injection + booking detection |
| `/add-clay` | Clay enrichment workflows |

## Open Core Model

Core orchestrator, prospect memory, sequence engine, BDR brain (basic), and base channel skills are MIT. Premium skills (advanced AI scoring, Clay/Apollo deep integration, multi-touch attribution, enterprise CRM connectors) are commercial.

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, read [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.bdrclaw.plist
launchctl unload ~/Library/LaunchAgents/com.bdrclaw.plist
launchctl kickstart -k gui/$(id -u)/com.bdrclaw  # restart

# Linux (systemd)
systemctl --user start bdrclaw
systemctl --user stop bdrclaw
systemctl --user restart bdrclaw
```
