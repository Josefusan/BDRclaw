# Contributing

Don't add features. Add skills.

## Before You Start

1. **Check for existing work.** Search open PRs and issues before starting:
   ```bash
   gh pr list --repo Josefusan/BDRclaw --search "<your feature>"
   gh issue list --repo Josefusan/BDRclaw --search "<your feature>"
   ```
   If a related PR or issue exists, build on it rather than duplicating effort.

2. **Check alignment.** Read the [README.md](README.md). Source code changes should only be things 90%+ of users need. Skills can be more niche, but should still be useful beyond a single person's setup.

3. **One thing per PR.** Each PR should do one thing — one bug fix, one skill, one simplification. Don't mix unrelated changes in a single PR.

## What Gets Merged to Core

- Security fixes
- Bug fixes
- Clear improvements to the base orchestrator

## What Ships as a Skill

- New channel integrations (LinkedIn, SMS, etc.)
- CRM connectors (HubSpot, Salesforce, Attio, Pipedrive, Close)
- Enrichment providers (Apollo, Clay, Hunter, Clearbit)
- Sequence templates
- OS/platform compatibility

If you want to add Salesforce support, don't open a PR that adds Salesforce to the core codebase. Fork BDRclaw, make the changes on a branch, and open a PR. We'll create a `skill/salesforce` branch others can merge into their fork.

## Skills

BDRclaw uses [Claude Code skills](https://code.claude.com/docs/en/skills) — markdown files with optional supporting files that teach Claude how to do something. There are four types of skills, each serving a different purpose.

### Why skills?

Every user should have clean and minimal code that does exactly what they need. Skills let users selectively add features to their fork without inheriting code for features they don't want.

### Skill types

#### 1. Feature skills (branch-based)

Add capabilities to BDRclaw by merging a git branch. The SKILL.md contains setup instructions; the actual code lives on a `skill/*` branch.

**Location:** `.claude/skills/` on `main` (instructions only), code on `skill/*` branch

**Examples:** `/add-linkedin`, `/add-hubspot`, `/add-apollo`, `/add-gmail`

**How they work:**
1. User runs `/add-linkedin`
2. Claude follows the SKILL.md: fetches and merges the `skill/linkedin` branch
3. Claude walks through interactive setup (env vars, API keys, etc.)

**Contributing a feature skill:**
1. Fork `Josefusan/BDRclaw` and branch from `main`
2. Make the code changes (new files, modified source, updated `package.json`, etc.)
3. Add a SKILL.md in `.claude/skills/<name>/` with setup instructions — step 1 should be merging the branch
4. Open a PR. We'll create the `skill/<name>` branch from your work

#### 2. Utility skills (with code files)

Standalone tools that ship code files alongside the SKILL.md. No branch merge needed. The code is self-contained in the skill directory.

**Location:** `.claude/skills/<name>/` with supporting files

**Guidelines:**
- Put code in separate files, not inline in the SKILL.md
- Use `${CLAUDE_SKILL_DIR}` to reference files in the skill directory
- SKILL.md contains installation instructions, usage docs, and troubleshooting

#### 3. Operational skills (instruction-only)

Workflows and guides with no code changes. The SKILL.md is the entire skill.

**Location:** `.claude/skills/` on `main`

**Examples:** `/setup`, `/debug`, `/customize`

**Guidelines:**
- Pure instructions — no code files, no branch merges
- Use `AskUserQuestion` for interactive prompts
- These stay on `main` and are always available to every user

#### 4. Container skills (agent runtime)

Skills that run inside the agent container, not on the host.

**Location:** `container/skills/<name>/`

**Guidelines:**
- Follow the same SKILL.md + frontmatter format
- Use `allowed-tools` frontmatter to scope tool permissions
- Keep them focused — the agent's context window is shared across all container skills

### Channel Skill Interface

Every channel skill must implement:

```typescript
interface Channel {
  name: string;
  type: 'inbound' | 'outbound' | 'bidirectional';
  init(): Promise<void>;
  send(prospectId: string, message: OutboundMessage): Promise<void>;
  onMessage(handler: MessageHandler): void;
}
```

And self-register in `src/channels/registry.ts` at startup if credentials are present.

### SKILL.md format

All skills use the [Claude Code skills standard](https://code.claude.com/docs/en/skills):

```markdown
---
name: my-skill
description: What this skill does and when to use it.
---

Instructions here...
```

**Rules:**
- Keep SKILL.md **under 500 lines** — move detail to separate reference files
- `name`: lowercase, alphanumeric + hyphens, max 64 chars
- `description`: required — Claude uses this to decide when to invoke the skill
- Put code in separate files, not inline in the markdown

## Testing

Test your contribution on a fresh clone before submitting. For skills, run the skill end-to-end and verify it works.

## Pull Requests

### Before opening

1. **Link related issues.** If your PR resolves an open issue, include `Closes #123` in the description.
2. **Test thoroughly.** Run the feature yourself. For skills, test on a fresh clone.
3. **Check the right box** in the PR template.

### PR description

Keep it concise. The description should cover:

- **What** — what the PR adds or changes
- **Why** — the motivation
- **How it works** — brief explanation of the approach
- **How it was tested** — what you did to verify it works
- **Usage** — how the user invokes it (for skills)

Don't pad the description. A few clear sentences are better than lengthy paragraphs.
