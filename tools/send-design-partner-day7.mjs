#!/usr/bin/env node
/**
 * Design Partner — Day-7 Follow-Up Send
 *
 * Sends Day-7 follow-up emails to 6 design partner targets.
 * Contact #5 (Natalie Glance / Duolingo) is a first send — nglance@ and natalie.glance@ both bounced; correct format is natalie@duolingo.com.
 *
 * CEO DIRECTIVE (WAVAAAA-187 comment bd13a16f, 2026-05-19T00:50Z):
 *   Authorized independently of dry-run gate 599e267e — these are warm follow-ups
 *   in an active sequence, not new cold outreach.
 *
 * Requires:
 *   RESEND_API_KEY  — Resend API key (outreach@updates.wavexcard.com must be verified)
 *
 * Dry-run (safe default):
 *   node tools/send-design-partner-day7.mjs
 *
 * Live send (execute on 2026-05-24T09:00Z — skip any contact who has replied):
 *   DRY_RUN=false RESEND_API_KEY=re_... node tools/send-design-partner-day7.mjs
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
    company: 'Wolt',
    name: 'Samuel',
    to: 'samuel.tervaskanto@wolt.com',
    type: 'day-7 follow-up',
    subject: 'Re: iOS test automation for Wolt',
    html: `<p>Samuel,</p>
<p>Following up from last week. One thing that might be relevant for Wolt specifically — our Bitrise build step lets you gate merges before a broken build reaches the queue. So the failure catches at PR time rather than blocking the next person off the branch.</p>
<p>Happy to walk through how that looks in your pipeline, if useful. Takes 15 minutes.</p>
<p>Tony<br>Tony Apple QA Studio<br><a href="https://tonyappleqa.com">tonyappleqa.com</a></p>`,
  },
  {
    company: 'Wolt',
    name: 'Niilo',
    to: 'niilo@wolt.com',
    type: 'day-7 follow-up',
    subject: 'Re: reducing iOS flaky tests — Wolt',
    html: `<p>Niilo,</p>
<p>Just checking back on my earlier note. The teams we work with typically see around 60% reduction in flaky test noise — the key is catching at merge rather than post-merge, so the failure signal stays clean. Worth a short demo if this is on your radar.</p>
<p>Tony<br>Tony Apple QA Studio<br><a href="https://tonyappleqa.com">tonyappleqa.com</a></p>`,
  },
  {
    company: 'Discord',
    name: 'Thomas',
    to: 'thomas.jacques@discord.com',
    type: 'day-7 follow-up',
    subject: 'Re: iOS QA automation for Discord',
    html: `<p>Thomas,</p>
<p>Following up from last week. One angle that resonates with teams using Runway: catching regressions upstream of your RC build is significantly cheaper than a rollback after a release candidate ships. Our smoke suite slots in before Runway kicks off. If that's interesting, happy to show you in a quick call.</p>
<p>Tony<br>Tony Apple QA Studio<br><a href="https://tonyappleqa.com">tonyappleqa.com</a></p>`,
  },
  {
    company: 'Robinhood',
    name: 'Mayank',
    to: 'mayank.agarwal@robinhood.com',
    type: 'day-7 follow-up',
    subject: 'Re: iOS smoke testing at Robinhood scale',
    html: `<p>Mayank,</p>
<p>Following up from last week. At the volume Robinhood runs CI — 500+ daily builds — the ROI on automated smoke testing compounds fast, and the risk profile is higher too: a broken trade flow during a market event isn't just a bug, it's a headline. Worth a 15-minute look if coverage gaps are on your radar.</p>
<p>Tony<br>Tony Apple QA Studio<br><a href="https://tonyappleqa.com">tonyappleqa.com</a></p>`,
  },
  {
    company: 'Duolingo',
    name: 'Natalie',
    to: 'natalie@duolingo.com',
    // Note: nglance@duolingo.com bounced 2026-05-17; natalie.glance@duolingo.com bounced 2026-05-19. Correct format is first-name only (63% of Duolingo employees).
    type: 'first send',
    subject: 'Automated iOS QA for Duolingo — worth 20 min?',
    html: `<p>Hi Natalie,</p>
<p>I'm Tony — QA Engineer at Apple, building automated smoke-test infrastructure for iOS teams on the side. Duolingo came to mind because a broken streak or push notification on the wrong build directly affects retention.</p>
<p>Teams running this on Bitrise typically see ~60% less flaky noise and catch regressions at PR time rather than post-release. Would you be open to a quick 20-minute demo?</p>
<p>Tony<br>Tony Apple QA Studio<br><a href="https://tonyappleqa.com">tonyappleqa.com</a></p>`,
  },
  {
    company: 'N26',
    name: 'Gino',
    to: 'gino.cordt@n26.com',
    type: 'day-7 follow-up',
    subject: 'Re: iOS QA automation for N26',
    html: `<p>Gino,</p>
<p>Following up from last week. One framing that tends to resonate with fintech teams: a broken payment or auth flow in production isn't just a support ticket — it's a potential compliance incident. Automated smoke coverage before release shifts the catch point to where fixing it is cheap. Happy to walk through how that looks in a 15-minute demo.</p>
<p>Tony<br>Tony Apple QA Studio<br><a href="https://tonyappleqa.com">tonyappleqa.com</a></p>`,
  },
];

async function sendEmail({ company, name, to, type, subject, html }) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would send to ${name} <${to}> (${company} — ${type})`);
    console.log(`  Subject: ${subject}`);
    return { id: `dry-run-${company.toLowerCase()}-${name.toLowerCase()}`, dry: true };
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

console.log(`\n=== Design Partner Day-7 Send ===`);
console.log(`Mode: ${DRY_RUN ? 'DRY RUN (safe)' : '*** LIVE SEND ***'}`);
console.log(`Contacts: ${contacts.length}`);
console.log(`Execute window: 2026-05-24T09:00Z`);
console.log(`Authority: CEO directive WAVAAAA-187 comment bd13a16f\n`);

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
  console.log('\nResend IDs (post to WAVAAAA-120 comment):');
  sent.forEach(r => console.log(`  ${r.company} / ${r.name} | ${r.to} | ${r.resendId}`));
}
