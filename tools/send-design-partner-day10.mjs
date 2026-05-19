#!/usr/bin/env node
/**
 * Design Partner — Day-10 Break-Up Send
 *
 * Final (Day-10) email in the 4-email design partner sequence.
 * 6 contacts: Wolt x2, Discord, Robinhood, N26, Duolingo (natalie@duolingo.com — resolved via WAVAAAA-446).
 *
 * Pre-send checklist (verify on 2026-05-27 before live run):
 *   1. Check inbox / WAVAAAA-120 for replies — skip + route any respondents to cal.com/wavex/design-partner
 *   2. RESEND_API_KEY confirmed present in /Users/geniex/paperclip/.env
 *
 * Authority: WAVAAAA-445
 *
 * Dry-run (safe default):
 *   node tools/send-design-partner-day10.mjs
 *
 * Live send (execute on 2026-05-27T09:00Z):
 *   DRY_RUN=false RESEND_API_KEY=re_... node tools/send-design-partner-day10.mjs
 */

const DRY_RUN = process.env.DRY_RUN !== 'false';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM = 'Dylan | WaveX <outreach@updates.wavexcard.com>';
const REPLY_TO = 'tony@tonyappleqa.com';

if (!RESEND_API_KEY && !DRY_RUN) {
  console.error('RESEND_API_KEY is required for live sends.');
  process.exit(1);
}

const BODY_TEMPLATE = (name) => `<p>Hi ${name},</p>
<p>I have sent a few notes about the WaveX design partner program and have not heard back, so I will leave it here.</p>
<p>If mobile CI/CD reliability or test flakiness becomes a priority later, we would love to talk. First 3 design partners get $1k/mo (90-day pilot).</p>
<p><a href="https://cal.com/wavex/design-partner">https://cal.com/wavex/design-partner</a></p>
<p>Thanks for your time.<br>Dylan</p>`;

const SUBJECT = 'Closing the loop — WaveX design partner';

const contacts = [
  { company: 'Wolt',      name: 'Samuel',  to: 'samuel.tervaskanto@wolt.com' },
  { company: 'Wolt',      name: 'Niilo',   to: 'niilo@wolt.com' },
  { company: 'Discord',   name: 'Thomas',  to: 'thomas.jacques@discord.com' },
  { company: 'Robinhood', name: 'Mayank',  to: 'mayank.agarwal@robinhood.com' },
  { company: 'N26',       name: 'Gino',    to: 'gino.cordt@n26.com' },
  // Duolingo excluded per board pre-flight 2026-05-19. nglance@ and natalie.glance@ both bounced;
  // natalie@duolingo.com resolved by WAVAAAA-446 but board elected to exclude from Day-10.
];

async function sendEmail({ company, name, to }) {
  const html = BODY_TEMPLATE(name);
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would send to ${name} <${to}> (${company})`);
    console.log(`  Subject: ${SUBJECT}`);
    return { id: `dry-run-${company.toLowerCase()}-${name.toLowerCase()}`, dry: true };
  }

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, reply_to: REPLY_TO, to: [to], subject: SUBJECT, html }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Resend error ${resp.status} for ${to}: ${err}`);
  }

  return resp.json();
}

console.log(`\n=== Design Partner Day-10 Break-Up Send ===`);
console.log(`Mode: ${DRY_RUN ? 'DRY RUN (safe)' : '*** LIVE SEND ***'}`);
console.log(`Contacts: ${contacts.length}`);
console.log(`Execute window: 2026-05-27T09:00Z`);
console.log(`Authority: WAVAAAA-445\n`);

const results = [];
for (const contact of contacts) {
  try {
    const result = await sendEmail(contact);
    results.push({ ...contact, success: true, resendId: result.id });
    console.log(`✅ ${contact.company} / ${contact.name} → ${contact.to} | id=${result.id}`);
  } catch (err) {
    results.push({ ...contact, success: false, error: err.message });
    console.error(`❌ ${contact.company} / ${contact.name} → ${contact.to} | ${err.message}`);
  }
  if (!DRY_RUN) await new Promise(r => setTimeout(r, 500));
}

console.log('\n=== Summary ===');
const sent = results.filter(r => r.success);
const failed = results.filter(r => !r.success);
console.log(`Sent: ${sent.length}/${results.length}`);
if (failed.length) {
  console.log('Failed:');
  failed.forEach(f => console.log(`  ${f.company} / ${f.name}: ${f.error}`));
}

if (!DRY_RUN) {
  console.log('\nResend IDs (post to WAVAAAA-120 comment):');
  sent.forEach(r => console.log(`  ${r.company} / ${r.name} | ${r.to} | ${r.resendId}`));
}
