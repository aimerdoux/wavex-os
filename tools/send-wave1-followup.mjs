#!/usr/bin/env node
/**
 * Wave 1 — 48h Follow-up Send
 *
 * Sends short follow-up emails to the 5 Wave 1 recipients.
 * Contact #5 (Slice / David Billingham) is a re-send — original bounced.
 *
 * Requires:
 *   RESEND_API_KEY  — Resend API key (must have outreach@updates.wavexcard.com verified)
 *
 * Dry-run (safe default):
 *   node tools/send-wave1-followup.mjs
 *
 * Live send:
 *   DRY_RUN=false node tools/send-wave1-followup.mjs
 */

const DRY_RUN = process.env.DRY_RUN !== 'false';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM = 'Tony Stark | Tony Apple QA <outreach@updates.wavexcard.com>';
const REPLY_TO = 'tony@tonyappleqa.com';

if (!RESEND_API_KEY && !DRY_RUN) {
  console.error('RESEND_API_KEY is required for live sends. Run with DRY_RUN=false RESEND_API_KEY=re_...');
  process.exit(1);
}

const contacts = [
  {
    company: 'Onfleet',
    name: 'Kjell',
    to: 'kjell@onfleet.com',
    type: 'follow-up',
    subject: 'Following up — iOS QA automation for Onfleet',
    html: `<p>Kjell,</p>
<p>Just making sure my earlier note didn't get buried. If iOS regressions in the driver app are something your team actively manages, I'd love to show you what we've built — takes about 15 minutes.</p>
<p>No pressure if the timing's off — just wanted to make sure it landed.</p>
<p>Tony<br>Tony Apple QA Studio<br><a href="https://tonyappleqa.com">tonyappleqa.com</a></p>`,
  },
  {
    company: 'BuildOps',
    name: 'Dzmitry',
    to: 'dzmitry@buildops.com',
    type: 'follow-up',
    subject: 'Following up — automated iOS smoke tests for BuildOps',
    html: `<p>Dzmitry,</p>
<p>Following up on my note from earlier this week. If iOS test coverage before field releases is something on your roadmap, happy to walk you through a quick demo — or send a short recording if a live call is hard to fit in.</p>
<p>Either way, no worries.</p>
<p>Tony<br>Tony Apple QA Studio<br><a href="https://tonyappleqa.com">tonyappleqa.com</a></p>`,
  },
  {
    company: 'Current',
    name: 'Trevor',
    to: 'trevor@current.com',
    type: 'follow-up',
    subject: 'Following up — iOS QA automation for Current',
    html: `<p>Trevor,</p>
<p>Just checking in on my last email. If automated pre-release coverage for Current's mobile app is something your team is thinking about, worth a 15-minute conversation.</p>
<p>If not the right time, totally fine.</p>
<p>Tony<br>Tony Apple QA Studio<br><a href="https://tonyappleqa.com">tonyappleqa.com</a></p>`,
  },
  {
    company: 'Branch',
    name: 'Sean',
    to: 'sean.brandow@branchapp.com',
    type: 'follow-up',
    subject: 'Following up — iOS smoke testing for Branch',
    html: `<p>Sean,</p>
<p>Following up from earlier this week. If catching iOS regressions before they reach your shift-worker users is something Branch invests in, I'd love to show you what we've built — it integrates in a couple of days.</p>
<p>Happy to keep it short.</p>
<p>Tony<br>Tony Apple QA Studio<br><a href="https://tonyappleqa.com">tonyappleqa.com</a></p>`,
  },
  {
    company: 'Slice',
    name: 'David',
    to: 'david.billingham@slicelife.com',
    // Note: original Wave 1 bounced (david@slicelife.com). This is first contact for David.
    type: 're-send',
    subject: 'Automated iOS QA for Slice — worth 20 min?',
    html: `<p>Hi David,</p>
<p>I'm Tony — QA Engineer at Apple, building automated smoke-test infrastructure for iOS/Android teams on the side. Slice's ordering app came to mind because peak-time iOS crashes translate directly to lost GMV for your restaurant partners.</p>
<p>Would you be open to a quick 20-minute demo to see if this is relevant for your team?</p>
<p>Tony<br>Tony Apple QA Studio<br><a href="https://tonyappleqa.com">tonyappleqa.com</a></p>`,
  },
];

async function sendEmail({ company, name, to, type, subject, html }) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would send to ${name} <${to}> (${company} — ${type})`);
    console.log(`  Subject: ${subject}`);
    return { id: `dry-run-${company.toLowerCase()}`, dry: true };
  }

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, reply_to: REPLY_TO, to: [to], subject, html }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Resend error ${resp.status} for ${to}: ${err}`);
  }

  return resp.json();
}

console.log(`\n=== Wave 1 Follow-up Send ===`);
console.log(`Mode: ${DRY_RUN ? 'DRY RUN (safe)' : '*** LIVE SEND ***'}`);
console.log(`Contacts: ${contacts.length}`);
console.log(`Deadline: 2026-05-19T22:14Z (48h from Wave 1 send)\n`);

const results = [];
for (const contact of contacts) {
  try {
    const result = await sendEmail(contact);
    results.push({ ...contact, success: true, resendId: result.id });
    console.log(`✅ ${contact.company} (${contact.type}) → ${contact.to} | id=${result.id}`);
  } catch (err) {
    results.push({ ...contact, success: false, error: err.message });
    console.error(`❌ ${contact.company} → ${contact.to} | ${err.message}`);
  }
  // Respectful delay between sends
  if (!DRY_RUN) await new Promise(r => setTimeout(r, 500));
}

console.log('\n=== Summary ===');
const sent = results.filter(r => r.success);
const failed = results.filter(r => !r.success);
console.log(`Sent: ${sent.length}/${results.length}`);
if (failed.length) {
  console.log('Failed:');
  failed.forEach(f => console.log(`  ${f.company}: ${f.error}`));
}

if (!DRY_RUN) {
  console.log('\nResend IDs (for Paperclip comment):');
  sent.forEach(r => console.log(`  ${r.company} | ${r.to} | ${r.resendId}`));
}
