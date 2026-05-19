#!/usr/bin/env node
/**
 * Wave 3 — Initial Cold Outreach Send
 *
 * Sends initial cold outreach emails to 10 Wave 3 contacts.
 *
 * GATE: Board approval 599e267e must be lifted before executing.
 * Execute immediately on approval — contacts verified (WAVAAAA-460).
 *
 * Contacts (verified WAVAAAA-460):
 *   CompanyCam    | Keegan Rice      | keegan@companycam.com
 *   Connecteam    | Daniel Nuriel    | daniel@connecteam.com
 *   Zuper         | Raghav Gurumani  | raghav@zuper.co
 *   Raken         | Kevin McKee      | kevin.mckee@rakenapp.com
 *   FieldPulse    | Gabriel Pinchev  | gabriel@fieldpulse.com
 *   Breezeway     | Paul Northup     | paul.northup@breezeway.io
 *   Greenlight    | Sameera Rao      | sameera.rao@greenlightcard.com
 *   Step          | Alexey K.        | alexey@step.com
 *   Albert        | Rishi Patel      | rishi@albert.com
 *   Brightline    | Vicki Mar        | vmar@hellobrightline.com
 *
 * Requires:
 *   RESEND_API_KEY  — Resend API key (outreach@updates.wavexcard.com verified)
 *                     Key is at /Users/geniex/paperclip/.env
 *
 * Dry-run (safe default):
 *   node tools/send-wave3.mjs
 *
 * Live send (on 599e267e approval):
 *   source /Users/geniex/paperclip/.env && DRY_RUN=false node tools/send-wave3.mjs
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
    company: 'CompanyCam',
    name: 'Keegan',
    to: 'keegan@companycam.com',
    type: 'initial cold',
    subject: 'iOS QA automation for CompanyCam — worth 20 min?',
    html: `<p>Hi Keegan,</p>
<p>I'm Tony — QA Engineer at Apple, building automated smoke-test infrastructure for iOS teams on the side. CompanyCam came to mind because a broken photo capture or sync flow in the field isn't just a bug — it's a contractor who can't document their work and a missed payment dispute.</p>
<p>We help mobile engineering teams catch iOS regressions before release so field users get a reliable experience. Worth a 20-minute demo?</p>
<p>Tony<br>Tony Apple QA Studio<br><a href="https://tonyappleqa.com">tonyappleqa.com</a></p>`,
  },
  {
    company: 'Connecteam',
    name: 'Daniel',
    to: 'daniel@connecteam.com',
    type: 'initial cold',
    subject: 'iOS QA automation for Connecteam — worth 20 min?',
    html: `<p>Hi Daniel,</p>
<p>I'm Tony — QA Engineer at Apple, building automated smoke-test infrastructure for iOS teams. Connecteam came to mind because your app serves 400M deskless workers — a broken shift scheduling or communication flow in the field is a support ticket that your customers can't afford to file in the middle of a job.</p>
<p>We help teams catch iOS regressions before release with automated smoke coverage. Worth a 20-minute demo?</p>
<p>Tony<br>Tony Apple QA Studio<br><a href="https://tonyappleqa.com">tonyappleqa.com</a></p>`,
  },
  {
    company: 'Zuper',
    name: 'Raghav',
    to: 'raghav@zuper.co',
    type: 'initial cold',
    subject: 'iOS QA automation for Zuper — worth 20 min?',
    html: `<p>Hi Raghav,</p>
<p>I'm Tony — QA Engineer at Apple, building automated smoke-test infrastructure for iOS teams. Zuper came to mind because your FSM platform is mission-critical for service businesses — a broken work order or scheduling flow isn't a minor inconvenience, it's a dispatched technician arriving with incomplete job information.</p>
<p>We help teams catch iOS regressions before release. Worth a 20-minute call?</p>
<p>Tony<br>Tony Apple QA Studio<br><a href="https://tonyappleqa.com">tonyappleqa.com</a></p>`,
  },
  {
    company: 'Raken',
    name: 'Kevin',
    to: 'kevin.mckee@rakenapp.com',
    type: 'initial cold',
    subject: 'iOS QA automation for Raken — worth 20 min?',
    html: `<p>Hi Kevin,</p>
<p>I'm Tony — QA Engineer at Apple, building automated smoke-test infrastructure for iOS teams. Raken came to mind because daily reports and safety logs for construction teams have zero tolerance for app failures — a broken field report at end-of-day is a compliance gap, not just a support ticket.</p>
<p>We help teams catch iOS regressions before release so field crews can rely on the app. Worth a 20-minute look?</p>
<p>Tony<br>Tony Apple QA Studio<br><a href="https://tonyappleqa.com">tonyappleqa.com</a></p>`,
  },
  {
    company: 'FieldPulse',
    name: 'Gabriel',
    to: 'gabriel@fieldpulse.com',
    type: 'initial cold',
    subject: 'iOS QA automation for FieldPulse — worth 20 min?',
    html: `<p>Hi Gabriel,</p>
<p>I'm Tony — QA Engineer at Apple, building automated smoke-test infrastructure for iOS teams. FieldPulse came to mind because your all-in-one field service platform is the operational backbone for SMB service businesses — a broken job scheduling or invoicing flow doesn't just frustrate users, it blocks revenue.</p>
<p>We help teams catch iOS regressions before release. Worth a 20-minute demo?</p>
<p>Tony<br>Tony Apple QA Studio<br><a href="https://tonyappleqa.com">tonyappleqa.com</a></p>`,
  },
  {
    company: 'Breezeway',
    name: 'Paul',
    to: 'paul.northup@breezeway.io',
    type: 'initial cold',
    subject: 'iOS QA automation for Breezeway — worth 20 min?',
    html: `<p>Hi Paul,</p>
<p>I'm Tony — QA Engineer at Apple, building automated smoke-test infrastructure for iOS teams. Breezeway came to mind because your property operations platform serves property managers who depend on the app for same-day turnovers — a regression in inspection or task workflows means a guest check-in goes wrong, not just a bug report.</p>
<p>We help teams catch iOS regressions before release. Worth a 20-minute call?</p>
<p>Tony<br>Tony Apple QA Studio<br><a href="https://tonyappleqa.com">tonyappleqa.com</a></p>`,
  },
  {
    company: 'Greenlight',
    name: 'Sameera',
    to: 'sameera.rao@greenlightcard.com',
    type: 'initial cold',
    subject: 'iOS QA automation for Greenlight — worth 20 min?',
    html: `<p>Hi Sameera,</p>
<p>I'm Tony — QA Engineer at Apple, building automated smoke-test infrastructure for iOS teams. Greenlight came to mind because your app handles real money for families — a broken card management or spending controls flow isn't just a support ticket, it's a parent who can't trust the product at a critical moment.</p>
<p>We help teams catch iOS regressions before release with automated smoke coverage. Worth a 20-minute demo?</p>
<p>Tony<br>Tony Apple QA Studio<br><a href="https://tonyappleqa.com">tonyappleqa.com</a></p>`,
  },
  {
    company: 'Step',
    name: 'Alexey',
    to: 'alexey@step.com',
    type: 'initial cold',
    subject: 'iOS QA automation for Step — worth 20 min?',
    html: `<p>Hi Alexey,</p>
<p>I'm Tony — QA Engineer at Apple, building automated smoke-test infrastructure for iOS teams. Step came to mind because your banking app for teens is trust-critical — a regression in spending, transfers, or account setup is a first financial experience that goes wrong, and that cohort is hard to win back.</p>
<p>We help teams catch iOS regressions before release. Worth a 20-minute call?</p>
<p>Tony<br>Tony Apple QA Studio<br><a href="https://tonyappleqa.com">tonyappleqa.com</a></p>`,
  },
  {
    company: 'Albert',
    name: 'Rishi',
    to: 'rishi@albert.com',
    type: 'initial cold',
    subject: 'iOS QA automation for Albert — worth 20 min?',
    html: `<p>Hi Rishi,</p>
<p>I'm Tony — QA Engineer at Apple, building automated smoke-test infrastructure for iOS teams. Albert came to mind because your AI financial assistant handles users' savings and financial decisions — a broken savings goal or budgeting flow isn't just a UX issue, it erodes the trust that your entire product is built on.</p>
<p>We help teams catch iOS regressions before release with automated smoke coverage. Worth a 20-minute demo?</p>
<p>Tony<br>Tony Apple QA Studio<br><a href="https://tonyappleqa.com">tonyappleqa.com</a></p>`,
  },
  {
    company: 'Brightline',
    name: 'Vicki',
    to: 'vmar@hellobrightline.com',
    type: 'initial cold',
    subject: 'iOS QA automation for Brightline — worth 20 min?',
    html: `<p>Hi Vicki,</p>
<p>I'm Tony — QA Engineer at Apple, building automated smoke-test infrastructure for iOS teams. Brightline came to mind because your children's behavioral health platform is high-stakes mobile — a broken session booking or care access flow isn't just a UX regression, it's a family that can't reach the care their child needs.</p>
<p>We help teams catch iOS regressions before release. Worth a 20-minute call?</p>
<p>Tony<br>Tony Apple QA Studio<br><a href="https://tonyappleqa.com">tonyappleqa.com</a></p>`,
  },
];

async function sendEmail({ company, name, to, type, subject, html }) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would send to ${name} <${to}> (${company} — ${type})`);
    console.log(`  Subject: ${subject}`);
    return { id: `dry-run-${company.toLowerCase().replace(/\s/g, '-')}`, dry: true };
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

console.log(`\n=== Wave 3 Initial Cold Outreach Send ===`);
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
  console.log('\nResend IDs (post to WAVAAAA-463 comment):');
  sent.forEach(r => console.log(`  ${r.company} / ${r.name} | ${r.to} | ${r.resendId}`));
}
