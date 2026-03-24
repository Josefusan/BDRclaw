# BDRclaw Security Model

## Summary

- Agents run in Linux containers, not behind application-level permission checks
- Each agent can only access explicitly mounted directories
- Per-prospect session isolation — no cross-contamination of context
- No credentials stored inside containers
- Secrets managed via `.env` on host, injected at container spawn time
- All outbound actions are logged to SQLite before execution (audit trail)

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main channel | Trusted | Private admin control |
| Prospect containers | Sandboxed | Per-prospect isolated execution |
| Channel skills | Sandboxed | Separate containers, separate credential mounts |
| Inbound replies | User input | Potential prompt injection |

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute in containers (lightweight Linux VMs), providing:
- **Process isolation** - Container processes cannot affect the host
- **Filesystem isolation** - Only explicitly mounted directories are visible
- **Non-root execution** - Runs as unprivileged `node` user (uid 1000)
- **Ephemeral containers** - Fresh environment per invocation (`--rm`)

This is the primary security boundary. Rather than relying on application-level permission checks, the attack surface is limited by what's mounted.

### 2. Per-Prospect Isolation

Each prospect gets their own container sandbox. The agent handling Acme Corp cannot see data from Widget Co.

- Prospect memory files (`prospects/{id}/CLAUDE.md`) are mounted individually
- No cross-prospect filesystem access
- Separate container invocations per prospect
- Touchpoint history is prospect-scoped in SQLite

### 3. Per-Skill Credential Isolation

A compromised LinkedIn skill cannot access your Gmail credentials — they're in separate containers with separate mounts.

- Each channel skill runs with only its own credentials
- API keys are injected per-skill, not globally
- Skills cannot enumerate other skills' credentials

### 4. Mount Security

**External Allowlist** - Mount permissions stored at `~/.config/bdrclaw/mount-allowlist.json`, which is:
- Outside project root
- Never mounted into containers
- Cannot be modified by agents

**Default Blocked Patterns:**
```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret
```

**Protections:**
- Symlink resolution before validation (prevents traversal attacks)
- Container path validation (rejects `..` and absolute paths)

**Read-Only Project Root:**

The project root is mounted read-only. Writable paths the agent needs (prospect folders, IPC, `.claude/`) are mounted separately. This prevents the agent from modifying host application code.

### 5. Session Isolation

Each prospect has isolated Claude sessions at `data/sessions/{prospect}/.claude/`:
- Prospects cannot see other prospects' conversation history
- Session data includes full message history and file contents read
- Prevents cross-prospect information disclosure

### 6. Credential Isolation (Credential Proxy)

Real API credentials **never enter containers**. Instead, the host runs an HTTP credential proxy that injects authentication headers transparently.

**How it works:**
1. Host starts a credential proxy on `CREDENTIAL_PROXY_PORT` (default: 3001)
2. Containers receive `ANTHROPIC_BASE_URL=http://host.docker.internal:<port>` and `ANTHROPIC_API_KEY=placeholder`
3. The SDK sends API requests to the proxy with the placeholder key
4. The proxy strips placeholder auth, injects real credentials, and forwards to `api.anthropic.com`
5. Agents cannot discover real credentials — not in environment, stdin, files, or `/proc`

**NOT Mounted:**
- Channel auth sessions — host only
- Mount allowlist — external, never mounted
- Any credentials matching blocked patterns
- `.env` is shadowed with `/dev/null` in the project root mount

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  Inbound Replies (email, LinkedIn, SMS, Slack)                    │
│  Prospect Messages (any channel)                                  │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Input validation, logging
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Message routing + channel registry                             │
│  • Mount validation (external allowlist)                          │
│  • Container lifecycle                                            │
│  • Credential proxy (injects auth headers)                       │
│  • BDR Brain scheduler                                            │
│  • SQLite audit trail (all actions logged before execution)       │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Explicit mounts only, no secrets
┌──────────────────────────────────────────────────────────────────┐
│                CONTAINER (ISOLATED/SANDBOXED)                     │
│  • Agent execution (per-prospect)                                 │
│  • Bash commands (sandboxed)                                      │
│  • File operations (limited to mounts)                            │
│  • API calls routed through credential proxy                     │
│  • No real credentials in environment or filesystem              │
│  • Channel skills in separate containers                          │
└──────────────────────────────────────────────────────────────────┘
```
