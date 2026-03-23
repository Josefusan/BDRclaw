# BDRClaw Specification

An AI sales development platform with multi-channel outreach, per-prospect memory, automated sequences, CRM hygiene, and container-isolated agent execution. Built as an open-core fork of NanoClaw.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Architecture: Channel System](#architecture-channel-system)
3. [Folder Structure](#folder-structure)
4. [Configuration](#configuration)
5. [Prospect Memory System](#prospect-memory-system)
6. [Sequence Engine](#sequence-engine)
7. [BDR Brain Agent](#bdr-brain-agent)
8. [Message Flow](#message-flow)
9. [Commands](#commands)
10. [Scheduled Tasks](#scheduled-tasks)
11. [MCP Servers](#mcp-servers)
12. [Deployment](#deployment)
13. [Security Considerations](#security-considerations)

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                        HOST (macOS / Linux)                           │
│                     (Main Node.js Process)                            │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌──────────────────┐                  ┌────────────────────┐        │
│  │ Channels         │─────────────────▶│   SQLite Database  │        │
│  │ (self-register   │◀────────────────│   (bdrclaw.db)     │        │
│  │  at startup)     │  store/send      └─────────┬──────────┘        │
│  └──────────────────┘                            │                   │
│                                                   │                   │
│         ┌─────────────────────────────────────────┘                   │
│         │                                                             │
│         ▼                                                             │
│  ┌──────────────────┐    ┌──────────────────┐    ┌───────────────┐   │
│  │  Message Loop    │    │  BDR Brain       │    │  IPC Watcher  │   │
│  │  (polls SQLite)  │    │  (daily sched.)  │    │  (file-based) │   │
│  └────────┬─────────┘    └────────┬─────────┘    └───────────────┘   │
│           │                       │                                   │
│           └───────────┬───────────┘                                   │
│                       │ spawns container                              │
│                       ▼                                               │
├──────────────────────────────────────────────────────────────────────┤
│                     CONTAINER (Linux VM)                               │
├──────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                    AGENT RUNNER                               │    │
│  │                                                                │    │
│  │  Working directory: /workspace/prospect (mounted from host)    │    │
│  │  Volume mounts:                                                │    │
│  │    • prospects/{id}/ → /workspace/prospect                     │    │
│  │    • prospects/global/ → /workspace/global/ (read-only)        │    │
│  │    • data/sessions/{prospect}/.claude/ → /home/node/.claude/   │    │
│  │    • Additional dirs → /workspace/extra/*                      │    │
│  │                                                                │    │
│  │  Tools (all agents):                                           │    │
│  │    • Bash (safe - sandboxed in container!)                     │    │
│  │    • Read, Write, Edit, Glob, Grep (file operations)           │    │
│  │    • WebSearch, WebFetch (internet access)                     │    │
│  │    • agent-browser (browser automation)                        │    │
│  │    • mcp__bdrclaw__* (scheduler tools via IPC)                 │    │
│  │                                                                │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Channel System | Channel registry (`src/channels/registry.ts`) | Channels self-register at startup |
| Data Storage | SQLite (better-sqlite3) | Prospects, touchpoints, sequences, CRM state |
| Container Runtime | Containers (Linux VMs) | Isolated environments for agent execution |
| Agent | @anthropic-ai/claude-agent-sdk | Run Claude with tools and MCP servers |
| Browser Automation | agent-browser + Chromium | Web interaction and screenshots |
| Runtime | Node.js 22+ | Host process for routing and scheduling |

---

## Architecture: Channel System

The core ships with no channels built in — each channel (Gmail, LinkedIn, SMS, Slack, WhatsApp, Telegram, Discord) is installed as a [Claude Code skill](https://code.claude.com/docs/en/skills) that adds the channel code to your fork. Channels self-register at startup; installed channels with missing credentials emit a WARN log and are skipped.

### Channel Registry

The channel system is built on a factory registry in `src/channels/registry.ts`:

```typescript
export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}
```

Each factory receives `ChannelOpts` (callbacks for `onMessage`, `onChatMetadata`, and `registeredGroups`) and returns either a `Channel` instance or `null` if that channel's credentials are not configured.

### Skill Interface Contract

Every channel skill must:
1. Self-register in `src/channels/registry.ts` at startup if credentials are present
2. Export a `send(prospectId, message)` function
3. Export a `receive()` polling function
4. Write all events to SQLite via `src/db.ts`
5. Update `prospects/{id}/CLAUDE.md` after every touchpoint

### Adding a New Channel

Contribute a skill to `.claude/skills/add-<name>/` that:

1. Adds a `src/channels/<name>.ts` file implementing the `Channel` interface
2. Calls `registerChannel(name, factory)` at module load
3. Returns `null` from the factory if credentials are missing
4. Adds an import line to `src/channels/index.ts`

---

## Folder Structure

```
bdrclaw/
├── CLAUDE.md                      # Project context for Claude Code
├── docs/
│   ├── SPEC.md                    # This specification document
│   ├── REQUIREMENTS.md            # Architecture decisions
│   └── SECURITY.md                # Security model
├── README.md                      # User documentation
├── package.json                   # Node.js dependencies
├── tsconfig.json                  # TypeScript configuration
├── .mcp.json                      # MCP server configuration (reference)
├── .gitignore
│
├── src/
│   ├── index.ts                   # Orchestrator: state, message loop, agent invocation
│   ├── channels/
│   │   ├── registry.ts            # Channel factory registry
│   │   └── index.ts               # Barrel imports for channel self-registration
│   ├── ipc.ts                     # IPC watcher and task processing
│   ├── router.ts                  # Message formatting and outbound routing
│   ├── config.ts                  # Configuration constants
│   ├── types.ts                   # TypeScript interfaces (includes Channel)
│   ├── logger.ts                  # Pino logger setup
│   ├── db.ts                      # SQLite database (prospects, touchpoints, sequences)
│   ├── group-queue.ts             # Per-prospect queue with global concurrency limit
│   ├── mount-security.ts          # Mount allowlist validation for containers
│   ├── task-scheduler.ts          # Runs scheduled tasks (BDR Brain, follow-ups)
│   └── container-runner.ts        # Spawns agents in containers
│
├── container/
│   ├── Dockerfile                 # Container image
│   ├── build.sh                   # Build script for container image
│   ├── agent-runner/              # Code that runs inside the container
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts           # Entry point
│   │       └── ipc-mcp-stdio.ts   # Stdio-based MCP server for host communication
│   └── skills/
│       └── agent-browser.md       # Browser automation skill
│
├── dist/                          # Compiled JavaScript (gitignored)
│
├── .claude/
│   └── skills/
│       ├── setup/SKILL.md              # /setup
│       ├── customize/SKILL.md          # /customize
│       ├── debug/SKILL.md              # /debug
│       ├── add-gmail/SKILL.md          # /add-gmail (core)
│       ├── add-telegram/SKILL.md       # /add-telegram (core)
│       ├── add-whatsapp/SKILL.md       # /add-whatsapp (core)
│       ├── add-slack/SKILL.md          # /add-slack (core)
│       ├── add-linkedin/SKILL.md       # /add-linkedin (pro)
│       ├── add-hubspot/SKILL.md        # /add-hubspot (pro)
│       ├── add-apollo/SKILL.md         # /add-apollo (pro)
│       ├── add-sms/SKILL.md            # /add-sms (pro)
│       └── add-cal/SKILL.md            # /add-cal (pro)
│
├── prospects/
│   ├── global/CLAUDE.md           # Global memory (all prospects read this)
│   └── {id}/                      # Per-prospect folders
│       ├── CLAUDE.md              # Prospect-specific memory (identity, stage, touchpoints)
│       └── *.md                   # Notes, research created by the agent
│
├── sequences/
│   └── *.md                       # Outreach sequence definitions
│
├── store/                         # Local data (gitignored)
│   └── bdrclaw.db                 # SQLite database
│
├── data/                          # Application state (gitignored)
│   ├── sessions/                  # Per-prospect session data
│   ├── env/env                    # Copy of .env for container mounting
│   └── ipc/                       # Container IPC (messages/, tasks/)
│
└── logs/                          # Runtime logs (gitignored)
    ├── bdrclaw.log                # Host stdout
    └── bdrclaw.error.log          # Host stderr
```

---

## Configuration

### Environment Variables

```env
ANTHROPIC_API_KEY=
DATABASE_URL=./data/bdrclaw.db
TRIGGER_WORD=@BDR
MAIN_CHANNEL=telegram
AUTO_SEND=false
DAILY_BRAIN_RUN=07:00
```

| Variable | Purpose | Default |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | Claude API authentication | Required |
| `DATABASE_URL` | SQLite database path | `./data/bdrclaw.db` |
| `TRIGGER_WORD` | Trigger pattern for messages | `@BDR` |
| `MAIN_CHANNEL` | Admin channel for pipeline reports | `telegram` |
| `AUTO_SEND` | Send outreach without human review | `false` |
| `DAILY_BRAIN_RUN` | When BDR Brain runs daily | `07:00` |
| `CONTAINER_IMAGE` | Agent container image | `bdrclaw-agent:latest` |
| `MAX_CONCURRENT_CONTAINERS` | Concurrency limit | `5` |

---

## Prospect Memory System

BDRClaw uses a per-prospect memory system based on CLAUDE.md files.

### Prospect Data Model

Each prospect lives at `prospects/{id}/CLAUDE.md`:

```markdown
# Prospect: {Full Name}

## Identity
- Company: 
- Title: 
- LinkedIn: 
- Email: 
- Phone: 

## Pipeline Stage
- Stage: [new | contacted | engaged | qualified | meeting_set | closed_lost]
- Lead Score: /10
- Last Updated: 

## Touchpoint History
| Date | Channel | Message Summary | Response |
|------|---------|----------------|----------|

## Notes
- 

## Next Action
- Action: 
- Channel: 
- Scheduled: 
```

### Memory Hierarchy

| Level | Location | Read By | Written By | Purpose |
|-------|----------|---------|------------|---------|
| **Global** | `prospects/global/CLAUDE.md` | All agents | Main only | Company info, personas, global sequencing rules |
| **Prospect** | `prospects/{id}/CLAUDE.md` | That prospect's agent | That prospect's agent | Prospect-specific context, touchpoint history |
| **Files** | `prospects/{id}/*.md` | That prospect's agent | That prospect's agent | Research, notes, enrichment data |

### How Memory Works

1. **Agent Context Loading**
   - Agent runs with `cwd` set to `prospects/{id}/`
   - Claude Agent SDK automatically loads `CLAUDE.md` for context
   - Global memory is available read-only

2. **Writing Memory**
   - After every touchpoint, the agent updates `CLAUDE.md` with the new touchpoint entry
   - Lead scores are updated by the BDR Brain agent
   - Pipeline stage changes are logged with timestamps

---

## Sequence Engine

Sequences are defined in `sequences/*.md` and executed by the scheduler.

### Sequence Format

```markdown
# Sequence: Cold Outreach v1

## Steps
1. Day 0  — LinkedIn connection request (personalized note)
2. Day 2  — LinkedIn DM (value-first, no pitch)
3. Day 5  — Cold email (problem + social proof)
4. Day 8  — Email follow-up #1 (short, bump)
5. Day 12 — Email follow-up #2 (breakup email)
6. Day 15 — SMS (if phone available)

## Exit Conditions
- Reply on any channel → move to [engaged], notify human
- Meeting booked → move to [meeting_set]
- Unsubscribe / negative reply → move to [closed_lost], halt sequence
```

### Execution Rules

- The agent reads the sequence, checks the prospect's touchpoint history, and executes only the next appropriate step
- Never double-sends across channels
- Exit conditions are checked before each step
- Sequence enrollment is tracked in SQLite

---

## BDR Brain Agent

The strategic layer of BDRClaw. Runs on a configurable schedule (default: daily at 7am).

### Responsibilities

1. Review all prospects in the pipeline
2. Score each lead 1-10 based on engagement signals
3. Identify who needs a follow-up today and on which channel
4. Draft the next message for each prospect (queue for review unless `AUTO_SEND=true`)
5. Flag hot leads (replied, opened 3+ times, visited pricing page)
6. Update each prospect's `CLAUDE.md` with assessment
7. Generate a daily pipeline summary and send to the main channel

### Constraints

- Never send the same message twice
- Never contact a prospect who has unsubscribed
- Always personalize based on the prospect's `CLAUDE.md` history
- Respect sequence step ordering and timing

---

## Message Flow

### Incoming Message Flow

```
1. User sends a command via main channel (e.g. @BDR add prospect...)
   │
   ▼
2. Channel receives message
   │
   ▼
3. Message stored in SQLite
   │
   ▼
4. Message loop polls SQLite (every 2 seconds)
   │
   ▼
5. Router checks:
   ├── Does message match trigger pattern? → No: ignore
   └── Is this an admin command? → Route appropriately
   │
   ▼
6. Router invokes Claude Agent SDK in container
   │
   ▼
7. Claude processes command:
   ├── Add prospect → create prospects/{id}/CLAUDE.md
   ├── Enroll in sequence → update SQLite, schedule steps
   ├── Pipeline query → read all prospects, summarize
   └── Other → execute in context
   │
   ▼
8. Response sent back via channel
```

### Outbound Message Flow (Sequences)

```
1. BDR Brain or scheduler determines next touchpoint
   │
   ▼
2. Check prospect CLAUDE.md for current state
   │
   ▼
3. Check sequence for next step + exit conditions
   │
   ▼
4. If AUTO_SEND=true: send immediately via channel
   If AUTO_SEND=false: queue for human review
   │
   ▼
5. Update prospect CLAUDE.md with new touchpoint
   │
   ▼
6. Log event to SQLite
```

---

## Commands

From the main channel:

| Command | Example | Effect |
|---------|---------|--------|
| Add prospect | `@BDR add prospect: Sarah Chen, VP Eng at Acme Corp, sarah@acme.com` | Create prospect record |
| Enroll in sequence | `@BDR enroll Sarah Chen in Cold Outreach v1` | Start sequence execution |
| Pipeline review | `@BDR what's the pipeline looking like` | Summarize all prospects |
| Hot leads | `@BDR who are our hottest leads` | Filter by lead score |
| Pause outreach | `@BDR pause all outreach to Acme Corp` | Suspend sequences |
| Pipeline report | `@BDR generate a pipeline report` | Full report to main channel |
| Update stage | `@BDR mark Sarah Chen as qualified` | Update pipeline stage |
| List tasks | `@BDR list all scheduled tasks` | Show scheduled BDR tasks |

---

## Scheduled Tasks

BDRClaw has a built-in scheduler for the BDR Brain and sequence execution.

### Schedule Types

| Type | Value Format | Example |
|------|--------------|---------|
| `cron` | Cron expression | `0 7 * * *` (daily at 7am) |
| `interval` | Milliseconds | `3600000` (every hour) |
| `once` | ISO timestamp | `2026-03-25T09:00:00Z` |

### Default Scheduled Tasks

- **BDR Brain daily run** — `DAILY_BRAIN_RUN` (default: `07:00`) — full pipeline review
- **Sequence step execution** — checks for due sequence steps every hour
- **Reply classification** — processes inbound replies and updates prospect state

---

## MCP Servers

### BDRClaw MCP (built-in)

The `bdrclaw` MCP server is created dynamically per agent call.

**Available Tools:**
| Tool | Purpose |
|------|---------|
| `schedule_task` | Schedule a recurring or one-time task |
| `list_tasks` | Show tasks |
| `get_task` | Get task details and run history |
| `update_task` | Modify task prompt or schedule |
| `pause_task` | Pause a task |
| `resume_task` | Resume a paused task |
| `cancel_task` | Delete a task |
| `send_message` | Send a message to the main channel |

---

## Deployment

BDRClaw runs as a single process via launchd (macOS) or systemd (Linux).

### Startup Sequence

1. **Ensures container runtime is running** — starts it if needed; kills orphaned containers
2. Initializes the SQLite database
3. Loads state from SQLite (prospects, sequences, sessions)
4. **Connects channels** — loops through registered channels, instantiates those with credentials
5. Once at least one channel is connected:
   - Starts the BDR Brain scheduler
   - Starts the IPC watcher for container messages
   - Sets up the per-prospect queue
   - Starts the message polling loop

---

## Security Considerations

See [SECURITY.md](SECURITY.md) for the full model. Key points:

- **Per-prospect isolation** — each prospect's data is in its own container
- **Per-skill credential isolation** — LinkedIn can't access Gmail credentials
- **Container execution** — all agents run in sandboxed Linux VMs
- **Credential proxy** — real API keys never enter containers
- **Read-only project root** — agents can't modify host code
