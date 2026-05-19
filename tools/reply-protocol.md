# Tony Response Playbook — Inbound Reply Protocol

**Who uses this:** Tony Stark (founder)
**Context:** Replies to cold outreach from Wave 1–3 email sequences and LinkedIn DMs
**Voice:** Casual, direct, founder-to-founder. No decks. No feature lists. One ask: 15 min.
**Booking URL:** `https://cal.com/wavex/design-partner` *(⚠ unconfirmed live — see [WAVAAAA-120](/WAVAAAA/issues/WAVAAAA-120); if broken, send a direct calendar invite and follow up)*

---

## Scenario 1 — Positive / Interested

**Signal:** "This looks interesting," "Tell me more," "How does it work?", "I'd like to see a demo"

**Rule:** Reply within 4 hours. Don't explain the product. Book the call.

**Template:**

> Hey [Name],
>
> Glad it landed — let's just get on a call, it's way easier to show than describe.
>
> 15 minutes: I'll show you what it does on a live codebase and you can tell me if it's relevant to what you're dealing with.
>
> Here's my link: https://cal.com/wavex/design-partner
>
> — Tony

**Notes:**
- If they ask specific product questions before booking: answer in one sentence, then restate the cal link. Don't let email become a demo.
- If the cal link isn't live yet: "I'll send you a calendar invite right now — pick from what works for you" and send one immediately.

---

## Scenario 2 — Conditional / Qualified Interest

**Signal:** "Sounds interesting but we're mid-sprint," "Might be relevant later," "We're evaluating tools right now," "Send me more info"

**Rule:** Acknowledge the timing, hold the door open, lock in a future touchpoint. Don't push for the immediate call.

**Template:**

> Hey [Name],
>
> Makes sense — bad timing is real. We're being selective about who we bring in as design partners right now anyway, so there's no rush on my end.
>
> I'll check back in [3–4 weeks] when things settle down for you. If something changes before then and you want to jump the queue, you know where to find me.
>
> — Tony

**Notes:**
- "Send me more info" = they don't want to call. Send a single sentence of context + one asset (the LP or a brief summary), not a feature sheet. Then offer the call.
- Set a reminder to follow up in 30 days.

---

## Scenario 3 — Objection: We Have Internal QA

**Signal:** "We have an SDET team," "Our QA team handles this," "We've built our own tooling"

**Rule:** Acknowledge their team. Position WaveX as automation for the repetitive parts, not a replacement. Ask about the bottleneck.

**Template:**

> Hey [Name],
>
> That's exactly the context I want to understand better — teams with a dedicated QA function are usually dealing with a specific kind of problem: the repetitive regression coverage that eats up sprint capacity.
>
> Quick question before I say anything else: how much of your team's time each sprint goes into running the same smoke suite vs. building new coverage?
>
> If it's mostly new coverage, this probably isn't a fit. If there's a repetitive layer you're still running manually, it might be worth 15 minutes.
>
> — Tony

**Notes:**
- Do not name their tools or suggest theirs are inferior. Ask what's taking time.
- If they say "we've automated everything": "That's rare and honestly impressive — sounds like you've cracked it. Good luck with the release cycle." Close gracefully. Don't chase.

---

## Scenario 4 — Objection: Not the Right Time

**Signal:** "We're in a hiring freeze," "Big launch coming up," "Budget is tight this quarter," "Come back in Q3"

**Rule:** Don't fight the timing. Set a specific re-engage date and honor it.

**Template:**

> Hey [Name],
>
> Totally get it — wrong time is wrong time. I'll reach back out in [specific month, e.g. early July] when things hopefully settle down.
>
> One thing to keep in mind: the teams who've gotten the most out of the design-partner program started before a major launch, not after. But that's your call to make.
>
> Talk then.
>
> — Tony

**Notes:**
- The "before a launch" line plants a seed without being pushy. Use only if they mentioned an upcoming launch.
- Log the specific follow-up date. Don't just say "I'll follow up" — put it in your calendar.
- If budget is the stated blocker: "Design-partner pricing is $299/month with a 14-day trial, no card required to start — so the cost to evaluate is zero. But if budget is genuinely frozen, I'll check back in Q3."

---

## Scenario 5 — Objection: We Use Appium / Maestro / Custom Framework

**Signal:** "We're already on Appium," "We use Maestro internally," "We've built our own test runner," "We're invested in [tool]"

**Rule:** Never bash the tool. Ask about coverage gaps and manual steps — that's where the pain lives.

**Template:**

> Hey [Name],
>
> [Tool] is solid — we work alongside it, not instead of it. The question I'd want to explore is what's still manual: are your Appium suites running automatically on every PR, or is there still a human step deciding what to run and when?
>
> Most teams we talk to have the execution layer covered but still have a gap in coverage intelligence — knowing what's *not* being tested, and where the regression risk is going into a release.
>
> Worth a 15-minute conversation to see if that's relevant to your setup?
>
> — Tony

**Notes:**
- Sub out [Tool] for their specific tool (Appium / Maestro / BrowserStack / custom).
- "Coverage intelligence" is the wedge — most teams haven't fully automated *what* to test, just *how*.
- If they say "our framework is fully automated end to end": "That's great — sounds like you've solved it. If you ever run into gaps in coverage decisions or regression triage, feel free to reach back out."

---

## Scenario 6 — LinkedIn DM Reply

**Signal:** Any reply to a LinkedIn DM from the outreach sequence

**Rule:** Shorter, more conversational. LinkedIn DMs are not email — match the medium. One ask, no pitch.

**Templates by signal:**

**Positive / interested:**
> Hey [Name] — glad it landed. Easier to show than describe. You free for 15 min this week? Here's my booking link: https://cal.com/wavex/design-partner

**Curious but not ready:**
> Happy to share more context — what's the current setup for regression coverage on your team? Want to make sure it's even relevant before taking up your time.

**"Not for us" / brush-off:**
> Makes sense — appreciate the quick response. Good luck with the release cycle.

**Notes:**
- Do not copy-paste email templates into LinkedIn DMs. They read wrong.
- If they engage: move to email or a call fast. LinkedIn threads are lossy.
- Keep all DM replies under 3 sentences.

---

## Scenario 7 — No-Show After Booking

**Signal:** Contact booked a call via cal.com but did not appear at the scheduled time

**Rule:** Send one follow-up within 2 hours of the missed call. One. Don't send three.

**Template:**

> Hey [Name],
>
> Looks like we missed each other — no worries, happens.
>
> If you still want to talk, here's the link to rebook at your convenience: https://cal.com/wavex/design-partner
>
> If timing has changed and it's not the right moment, just let me know — I'll check back in a few weeks.
>
> — Tony

**Notes:**
- Subject line (email): `missed you — easy to rebook`
- Do not apologize or ask "did I have the wrong time?" — they no-showed, not you.
- If they rebook and no-show a second time: one final note ("Happy to make this work when the timing is better — let me know") then move on. Don't chase a third time.
- If the cal.com link isn't live: offer to send a new invite directly.

---

## Quick Reference

| Scenario | SLA | One-line rule |
|---|---|---|
| Positive / interested | 4h | Book the call, don't explain |
| Conditional / qualified | Same day | Acknowledge + future touchpoint |
| Internal QA objection | Same day | Ask about the repetitive layer |
| Not the right time | Same day | Set specific re-engage date |
| Competitor tool objection | Same day | Ask about coverage gaps, don't bash |
| LinkedIn DM | ASAP, ≤ 3 sentences | Match the medium |
| No-show | Within 2h | One follow-up, one rebook link |

---

*Grounded in: [WAVAAAA-469](/WAVAAAA/issues/WAVAAAA-469) reply protocol brief, [WAVAAAA-37](/WAVAAAA/issues/WAVAAAA-37) 5-touch sequence, [WAVAAAA-346](/WAVAAAA/issues/WAVAAAA-346) pricing brief, `tools/demo-script.md`.*
