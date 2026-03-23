# BDRClaw

AI sales development platform built on NanoClaw. See [README.md](README.md) for vision and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (Gmail, LinkedIn, SMS, Slack, WhatsApp, Telegram, Discord) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each prospect has isolated filesystem and memory via `prospects/*/CLAUDE.md`.

BDRClaw automates prospecting, outreach, follow-up, and CRM hygiene. The BDR Brain agent runs on a daily schedule to review the pipeline, score leads, and queue follow-up actions.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled BDR tasks (pipeline review, follow-ups) |
| `src/db.ts` | SQLite operations (prospects, touchpoints, sequences, CRM state) |
| `prospects/{id}/CLAUDE.md` | Per-prospect memory (isolated) |
| `sequences/*.md` | Outreach sequence definitions |
| `container/skills/` | Skills loaded inside agent containers |

## Skills

Four types of skills exist in BDRClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-linkedin`, `/add-hubspot`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |

### BDR-Specific Skills

| Skill | Type | Description |
|-------|------|-------------|
| `/add-gmail` | Core (Free) | Gmail / SMTP outreach |
| `/add-telegram` | Core (Free) | Telegram channel |
| `/add-whatsapp` | Core (Free) | WhatsApp channel |
| `/add-slack` | Core (Free) | Slack channel |
| `/add-linkedin` | Pro | LinkedIn DM + connection automation |
| `/add-hubspot` | Pro | HubSpot CRM sync |
| `/add-apollo` | Pro | Contact enrichment + lead import |
| `/add-sms` | Pro | Twilio SMS sequences |
| `/add-cal` | Pro | Cal.com / Calendly booking |

## Open Core Model

Core orchestrator, prospect memory, sequence engine, and base channel skills are MIT. Premium skills (LinkedIn, CRM integrations, enrichment, advanced intelligence) are commercial.

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, skill types, SKILL.md format rules, PR requirements, and the pre-submission checklist.

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
