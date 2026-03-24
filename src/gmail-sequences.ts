/**
 * Email sequence engine.
 *
 * Loads sequence templates from groups/main/sequences/*.md,
 * determines which step to send next for a prospect,
 * and personalizes the template with prospect data.
 *
 * Template format (YAML frontmatter + markdown body):
 *
 *   ---
 *   step: 1
 *   subject: "Quick question about {{company}}"
 *   ---
 *
 *   Hi {{firstName}},
 *   ...
 */

import fs from 'fs';
import path from 'path';

import { parse as parseYaml } from 'yaml';

import { GROUPS_DIR } from './config.js';
import { getTouchesForProspect } from './bdr-db.js';
import { logger } from './logger.js';
import type { BDRProspect } from './bdr-types.js';

const SEQUENCES_DIR = path.join(GROUPS_DIR, 'main', 'sequences');

export interface EmailTemplate {
  step: number;
  subject: string;
  body: string;
  filename: string;
}

export interface PersonalizedEmail {
  subject: string;
  body: string;
  stepNumber: number;
  isBreakup: boolean;
}

// ── Template Loading ──────────────────────────────────────────────────────────

let _cached: EmailTemplate[] | null = null;

export function loadSequenceTemplates(): EmailTemplate[] {
  if (_cached) return _cached;

  if (!fs.existsSync(SEQUENCES_DIR)) {
    logger.warn(
      { dir: SEQUENCES_DIR },
      'No sequences directory — using built-in fallback templates',
    );
    _cached = FALLBACK_TEMPLATES;
    return _cached;
  }

  const files = fs
    .readdirSync(SEQUENCES_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort();

  if (files.length === 0) {
    logger.warn('sequences/ is empty — using built-in fallback templates');
    _cached = FALLBACK_TEMPLATES;
    return _cached;
  }

  const templates: EmailTemplate[] = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(SEQUENCES_DIR, file), 'utf-8');
    const parsed = parseFrontmatter(raw, file);
    if (parsed) templates.push(parsed);
  }

  // Sort by step number
  templates.sort((a, b) => a.step - b.step);
  _cached = templates;
  logger.info({ count: templates.length }, 'Sequence templates loaded');
  return _cached;
}

/** Invalidate template cache (useful after user edits sequence files) */
export function reloadSequences(): void {
  _cached = null;
}

function parseFrontmatter(
  raw: string,
  filename: string,
): EmailTemplate | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    logger.warn({ filename }, 'Sequence file missing YAML frontmatter, skipping');
    return null;
  }

  try {
    const fm = parseYaml(match[1]) as Record<string, unknown>;
    const body = match[2].trim();
    return {
      step: typeof fm.step === 'number' ? fm.step : 1,
      subject: typeof fm.subject === 'string' ? fm.subject : '(no subject)',
      body,
      filename,
    };
  } catch (err) {
    logger.warn({ filename, err }, 'Failed to parse sequence frontmatter');
    return null;
  }
}

// ── Next Step Logic ───────────────────────────────────────────────────────────

/**
 * Returns the next personalized email to send for a prospect.
 * Returns null if the prospect has exhausted all sequence steps.
 */
export function getNextEmail(
  prospect: BDRProspect,
): PersonalizedEmail | null {
  const templates = loadSequenceTemplates();
  if (templates.length === 0) return null;

  // Count how many outbound emails we've already sent
  const touches = getTouchesForProspect(prospect.id);
  const emailsSent = touches.filter(
    (t) => t.channel === 'email' && t.direction === 'outbound',
  ).length;

  if (emailsSent >= templates.length) {
    logger.info(
      { prospectId: prospect.id, emailsSent, totalSteps: templates.length },
      'Prospect has completed all sequence steps',
    );
    return null;
  }

  const template = templates[emailsSent];
  const isBreakup = emailsSent === templates.length - 1;
  const senderEmail =
    process.env.GMAIL_ACCOUNT_1 || process.env.GMAIL_ACCOUNT_2 || '';
  const senderName =
    process.env.GMAIL_SENDER_NAME || senderEmail.split('@')[0] || 'BDR';

  return {
    subject: personalize(template.subject, prospect, senderName, senderEmail),
    body: personalize(template.body, prospect, senderName, senderEmail),
    stepNumber: emailsSent + 1,
    isBreakup,
  };
}

// ── Template Personalization ──────────────────────────────────────────────────

const VARS: Record<string, (p: BDRProspect, senderName: string, senderEmail: string) => string> = {
  firstName: (p) => p.name.split(' ')[0] || p.name,
  fullName: (p) => p.name,
  company: (p) => p.company,
  title: (p) => p.title,
  email: (p) => p.email ?? '',
  senderName: (_, sn) => sn,
  senderEmail: (_, _sn, se) => se,
};

function personalize(
  text: string,
  prospect: BDRProspect,
  senderName: string,
  senderEmail: string,
): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
    const fn = VARS[varName];
    return fn ? fn(prospect, senderName, senderEmail) : match;
  });
}

// ── Fallback Templates ────────────────────────────────────────────────────────
// Used when no sequences/ directory exists. Replace with your own.

const FALLBACK_TEMPLATES: EmailTemplate[] = [
  {
    step: 1,
    subject: 'Quick question about {{company}}',
    filename: 'fallback-1',
    body: `Hi {{firstName}},

I came across {{company}} and noticed [value prop relevant to their role].

I work with [ICP description] to [specific outcome]. We recently helped [social proof].

Worth a 15-minute call to see if there's a fit?

Best,
{{senderName}}`,
  },
  {
    step: 2,
    subject: 'Re: Quick question about {{company}}',
    filename: 'fallback-2',
    body: `Hi {{firstName}},

Just wanted to resurface this — I know your inbox is busy.

[Add a new angle or insight here — a case study, a stat, something relevant to {{company}}.]

Still worth a quick call?

{{senderName}}`,
  },
  {
    step: 3,
    subject: 'Re: Quick question about {{company}}',
    filename: 'fallback-3',
    body: `Hi {{firstName}},

One last reach out — if the timing's off, totally understand.

If [specific pain point] ever becomes a priority at {{company}}, happy to connect then.

Either way, good luck with everything.

{{senderName}}`,
  },
];
