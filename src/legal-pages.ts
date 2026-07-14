/**
 * Static privacy-policy and terms-of-service content for BDRclaw.
 *
 * Required before the Twilio A2P 10DLC campaign filing: TCR reviewers check the
 * live website for a privacy policy that describes SMS consent, opt-out (STOP)
 * and help (HELP) handling, message frequency, that message & data rates may
 * apply, and — critically — that mobile opt-in data is not shared with third
 * parties for marketing (see docs/TWILIO-10DLC-SETUP.md).
 *
 * These render the inner page body only; web-ui.ts wraps them in the shared
 * legalPageShell. Legal-entity name and mailing address come from the same
 * env-backed helpers used by the CAN-SPAM email footer, with clearly-marked
 * placeholders when unset (Joseph supplies the real values).
 */

import {
  legalName,
  mailingAddress,
  publicBaseUrl,
} from './email-compliance.js';

// Effective date is a fixed constant so redeploys don't churn the page.
const EFFECTIVE_DATE = '2026-07-10';

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Contact email for privacy/opt-out inquiries. */
function contactEmail(): string {
  return (
    process.env.BDR_UNSUBSCRIBE_EMAIL?.trim() ||
    process.env.BDR_CLOSER_EMAIL?.trim() ||
    'privacy@bdrclaw.dev'
  );
}

export function renderPrivacyContent(): string {
  const company = esc(legalName());
  const address = esc(mailingAddress());
  const email = esc(contactEmail());
  const domain = esc(publicBaseUrl());

  return `
<h1>Privacy Policy</h1>
<p class="muted">Effective ${EFFECTIVE_DATE}</p>

<p>${company} ("we", "us", "our") operates BDRclaw, an outreach-automation
service. This policy explains what we collect, how we use it, and the choices
you have. By using our service or receiving messages from us you agree to this
policy.</p>

<h2>Information We Collect</h2>
<ul>
  <li><strong>Contact data</strong> you or your organization provide about
      business prospects (name, company, title, email address, phone number,
      social profiles).</li>
  <li><strong>Communication data</strong> — the messages we send and the replies
      we receive on your behalf, including delivery and engagement metadata.</li>
  <li><strong>Account &amp; usage data</strong> needed to operate the service.</li>
</ul>

<h2>How We Use Information</h2>
<p>We use the data to deliver outreach you configure, route and classify
replies, keep your CRM current, and operate, secure, and improve the service.
We do not sell personal information.</p>

<h2>SMS / Text Messaging</h2>
<ul>
  <li><strong>Consent / opt-in.</strong> We send SMS only to recipients who have
      opted in — by submitting their phone number through a web form, giving
      verbal agreement logged at the point of contact, or through an existing
      business relationship. Consent is recorded before the first message.</li>
  <li><strong>Opt-out (STOP).</strong> Reply <strong>STOP</strong> to any message
      (or CANCEL, END, QUIT, UNSUBSCRIBE) to be removed immediately. We honor
      opt-outs across all future messaging.</li>
  <li><strong>Help (HELP).</strong> Reply <strong>HELP</strong> for assistance,
      or contact us at ${email}.</li>
  <li><strong>Message frequency</strong> varies based on your conversation and
      campaign; it is not a fixed number and is typically low-volume,
      conversational follow-up.</li>
  <li><strong>Message and data rates may apply</strong> depending on your mobile
      carrier and plan.</li>
  <li><strong>Mobile opt-in data is not shared with third parties for marketing.</strong>
      We do not share or sell mobile opt-in information or phone numbers to third
      parties or affiliates for their own marketing purposes.</li>
</ul>

<h2>How We Share Information</h2>
<p>We share data only with service providers who help us operate (for example,
messaging carriers such as Twilio, email providers, and CRM systems you connect)
and only as needed to provide the service, or where required by law. We never
share mobile opt-in data with third parties for their marketing.</p>

<h2>Data Retention &amp; Security</h2>
<p>We retain data for as long as needed to provide the service and meet legal
obligations, then delete or de-identify it. We use reasonable administrative and
technical safeguards to protect it.</p>

<h2>Your Choices &amp; Rights</h2>
<p>You may opt out of email at any time via the unsubscribe link in every
message, or of SMS by replying STOP. To access, correct, or delete your data,
contact us at ${email}.</p>

<h2>Contact</h2>
<p>${company}<br>${address}<br>${email}<br><a href="${domain}">${domain}</a></p>
`;
}

export function renderTermsContent(): string {
  const company = esc(legalName());
  const address = esc(mailingAddress());
  const email = esc(contactEmail());

  return `
<h1>Terms of Service</h1>
<p class="muted">Effective ${EFFECTIVE_DATE}</p>

<p>These Terms of Service ("Terms") govern your use of BDRclaw, provided by
${company}. By accessing or using the service you agree to these Terms.</p>

<h2>The Service</h2>
<p>BDRclaw is an AI-assisted outreach-automation platform for business
development. You configure campaigns and audiences; the service composes,
schedules, sends, and manages replies across the channels you connect.</p>

<h2>Acceptable Use &amp; Your Responsibilities</h2>
<ul>
  <li>You are responsible for the contacts you upload and must have a lawful
      basis and, where required, consent to contact them.</li>
  <li>You will comply with all applicable laws and carrier rules, including
      CAN-SPAM, the TCPA, A2P 10DLC requirements, and anti-spam regulations.</li>
  <li>You will not use the service to send unlawful, deceptive, harassing, or
      prohibited content, or to contact recipients who have opted out.</li>
  <li>You will honor all opt-out requests (STOP for SMS, unsubscribe for email);
      the service enforces a suppression list, but responsibility remains yours.</li>
</ul>

<h2>Messaging Compliance</h2>
<p>SMS is sent only to recipients who have opted in. Recipients can reply STOP to
opt out or HELP for assistance at any time. Message and data rates may apply.
Mobile opt-in data is never shared with third parties for marketing. See our
<a href="/privacy">Privacy Policy</a> for details.</p>

<h2>Intellectual Property</h2>
<p>The service and its software are owned by ${company} and its licensors.
Portions of BDRclaw are open source under their respective licenses. You retain
ownership of your data.</p>

<h2>Disclaimers &amp; Limitation of Liability</h2>
<p>The service is provided "as is" without warranties of any kind. To the maximum
extent permitted by law, ${company} is not liable for any indirect, incidental,
or consequential damages, or for your failure to comply with applicable
messaging laws.</p>

<h2>Termination</h2>
<p>You may stop using the service at any time. We may suspend or terminate access
for violation of these Terms or applicable law.</p>

<h2>Changes to These Terms</h2>
<p>We may update these Terms; continued use after changes constitutes
acceptance of the updated Terms.</p>

<h2>Contact</h2>
<p>${company}<br>${address}<br>${email}</p>
`;
}
