#!/usr/bin/env node
/**
 * Wave 2 — Initial Cold Outreach Send
 *
 * Sends initial cold outreach emails to 5 Wave 2 contacts.
 *
 * GATE: Board approval 599e267e must be lifted before executing.
 * Execute immediately on approval — contacts enriched and script ready.
 *
 * Contacts (enriched WAVAAAA-183):
 *   Cerebral     | Sarah Griffis   | sarah.griffis@cerebral.com
 *   Lemonade     | Tal Cohen       | tal.cohen@lemonade.com
 *   Jobber       | Ryan Jones      | ryan.jones@getjobber.com
 *   Housecall Pro| Manish Singh    | manish.singh@housecallpro.com
 *   Bringg       | Alexander S.    | alexander.simenduev@bringg.com
 *
 * Requires:
 *   RESEND_API_KEY  — Resend API key (outreach@updates.wavexcard.com verified)
 *                     Key is at /Users/geniex/paperclip/.env
 *
 * Dry-run (safe default):
 *   node tools/send-wave2.mjs
 *
 * Live send (on 599e267e approval):
 *   source /Users/geniex/paperclip/.env && DRY_RUN=false node tools/send-wave2.mjs
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
    company: 'Cerebral',
    name: 'Sarah',
    to: 'sarah.griffis@cerebral.com',
    type: 'initial cold',
    subject: 'Automated iOS QA for Cerebral — worth 20 min?',
    html: `<p>Hi Sarah,</p>
<p>I'm Tony — QA Engineer at Apple, building automated smoke-test infrastructure for iOS teams on the side. Cerebral came to mind because a broken onboarding flow or medication reminder in your patient app isn't just a bug — it directly affects care continuity.</p>
<p>We help mobile engineering teams catch iOS regressions before release so patients get a reliable experience. Would you be open to a quick 20-minute demo?</p>
<p>Tony<br>Tony Apple QA Studio<br><a href="https://tonyappleqa.com">tonyappleqa.com</a></p>`,
  },
  {
    company: 'Lemonade',
    name: 'Tal',
    to: 'tal.cohen@lemonade.com',
    type: 'initial cold',
    subject: 'Automated iOS QA for Lemonade — worth 20 min?',
    html: `<p>Hi Tal,</p>
<p>I'm Tony — QA Engineer at Apple, building automated smoke-test infrastructure for iOS teams on the side. Lemonade's iOS app is trust-critical — a broken claim flow or login regression at the wrong moment can directly cost conversion and NPS.</p>
<p>We help teams catch those regressions before release with automated smoke coverage. Worth a 20-minute demo?</p>
<p>Tony<br>Tony Apple QA Studio<br><a href="https://tonyappleqa.com">tonyappleqa.com</a></p>`,
  },
  {
    company: 'Jobber',
    name: 'Ryan',
    to: 'ryan.jones@getjobber.com',
    type: 'initial cold',
    subject: 'iOS QA automation for Jobber — worth 20 min?',
    html: `<p>Hi Ryan,</p>
<p>I'm Tony — QA Engineer at Apple, building automated smoke-test infrastructure for iOS teams. Jobber came to mind because your app is mission-critical for field technicians — a broken scheduling or invoicing flow in the field means a service call goes wrong, not just a support ticket.</p>
<p>Automated pre-release smoke coverage catches those regressions before they hit your field users. Worth a 20-minute call?</p>
<p>Tony<br>Tony Apple QA Studio<br><a href="https://tonyappleqa.com">tonyappleqa.com</a></p>`,
  },
  {
    company: 'Housecall Pro',
    name: 'Manish',
    to: 'manish.singh@housecallpro.com',
    type: 'initial cold',
    subject: 'iOS QA automation for Housecall Pro — worth 20 min?',
    html: `<p>Hi Manish,</p>
<p>I'm Tony — QA Engineer at Apple, building automated smoke-test infrastructure for iOS teams. Housecall Pro's app is the backbone for your home service pros — a broken booking or payment flow in the field is a lost job, not just a bug report.</p>
<p>We help teams catch iOS regressions before release so your pros can work without interruption. Worth a 20-minute look?</p>
<p>Tony<br>Tony Apple QA Studio<br><a href="https://tonyappleqa.com">tonyappleqa.com</a></p>`,
  },
  {
    company: 'Bringg',
    name: 'Alexander',
    to: 'alexander.simenduev@bringg.com',
    type: 'initial cold',
    subject: 'iOS QA automation for Bringg — worth 20 min?',
    html: `<p>Hi Alexander,</p>
<p>I'm Tony — QA Engineer at Apple, building automated smoke-test infrastructure for iOS/Android teams. Bringg's delivery orchestration platform came to mind because a regression in driver tracking or dispatch at high delivery volume directly impacts SLA for your enterprise clients.</p>
<p>We help teams catch iOS regressions before release. Worth a 20-minute call?</p>
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

console.log(`\n=== Wave 2 Initial Cold Outreach Send ===`);
console.log(`Mode: ${DRY_RUN ? 'DRY RUN (safe)' : '*** LIVE SEND ***'}`);
console.log(`Contacts: ${contacts.length}`);
console.log(`Gate: Board approval 599e267e — fire immediately on approval\n`);

const results = [];
for (const contact of contacts) {
  try {
    const result = await sendEmail(contact);
    results.push({ ...contact, success: true, resendId: result.id });
    console.log(`✅ ${contact.company} / ${contact.name} (${contact.type}) → ${contact.to} | id=${result.id}`);
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
  console.log('\nResend IDs (post to WAVAAAA-182 comment):');
  sent.forEach(r => console.log(`  ${r.company} / ${r.name} | ${r.to} | ${r.resendId}`));
}
