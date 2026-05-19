# tony-apple-qa — 20-Min Demo Call Runbook

**Who runs this:** Tony Stark (founder)
**Who you're talking to:** VP Engineering / Head of Mobile / QA Lead
**Goal:** Confirm pain → show working product → close design-partner slot

---

## Pre-call prep (5 min before joining)

Review the following for the prospect's company:

- **App store presence:** are they live on iOS + Android? Note number of app versions in market.
- **CI signal:** look for Bitrise, GitHub Actions, or CircleCI in their GitHub org or job postings. This tells you what integrations to emphasize.
- **Release cadence:** any blog/release notes? Weekly releases = acute pain. Monthly = slower urgency.
- **QA signals:** job postings for SDET / mobile QA? Recent 1-star reviews mentioning crashes or regression bugs?
- **Team size:** if VP Eng title, they have a team. Ask about it — you want to know if QA is a dedicated function or falls on devs.

**Have open on your machine before joining:**
```bash
cd ~/wavex-os
pnpm dev:no-paperclip   # localhost:5173 + mock-core at :3101
```

---

## Opening (3 min) — pain discovery

Let them talk. You're listening for: manual QA volume, regression gaps, CI flakiness, release anxiety.

**Start:**
> "Before I show you anything — I want to make sure this is actually relevant to what you're dealing with. Can I ask a few quick questions?"

**Q1 (CI / Bitrise pain):**
> "Are your mobile smoke tests running automatically on every PR, or is there still a manual step before a release goes out?"

*Listen for: "we run some tests," "it's mostly manual," "our Bitrise pipeline is flaky" — any of these is a go signal.*

**Q2 (regression / pre-release fear):**
> "Has a regression shipped to prod in the last two sprints — something that passed internal QA but users found in the wild?"

*Listen for a specific incident. Most mobile teams have one. Get them to name it.*

**Q3 (QA cost / time):**
> "How much of your sprint capacity goes into regression coverage — dedicated SDET time, or is it spread across engineers?"

*You want the hours-per-sprint number. Even a rough estimate gives you the ROI anchor for the close.*

**Q4 (if still engaged, optional):**
> "Is your iOS test coverage keeping up with the OS version fragmentation — iOS 17, 18, new device classes?"

*If yes: lean in on device-profile coverage. If they haven't thought about it: you've just introduced a new risk they hadn't named.*

**Transition:**
> "Okay — I think I can show you something directly relevant. This is going to take about 10 minutes. I'm going to screen-share our product — it's running live on my machine."

---

## Demo walkthrough (10 min) — 5 core screens in order

**Screen 1 — Onboarding Wizard / 5-Pillar Intake** (~2 min)

Open `http://localhost:5173`.

> "This is the onboarding wizard — when a new team joins, they answer five questions. Watch what happens when you enter a company."

Enter a company URL. Wait ~85s for enrichment — narrate:
> "It's pulling your app metadata, inferring your release cycle, your CI setup, your QA maturity. You don't configure anything manually."

*Why it lands: shows zero-config intelligence — a VP doesn't want another tool that takes weeks to set up.*

---

**Screen 2 — Swarm Studio / Agent Roster** (~2 min)

After the wizard completes Pillars 1-2, show the generated roster.

> "Based on what it learned about your team, it's proposing a QA agent fleet — here's what gets provisioned: smoke test agents, regression coverage planners, a release checklist manager."

Point out the specific agent roles relevant to their pain (e.g., if they mentioned Bitrise: the CI integration agent).

*Why it lands: makes the product feel purpose-built for their stack, not generic.*

---

**Screen 3 — Mission Control / Fleet Dashboard** (~2 min)

After clicking "Activate Fleet":

> "This is Mission Control. Every agent in your QA fleet is visible here — what it's doing, when it last ran, what it found."

Show at least one agent with `status: running` or a recent heartbeat.

> "This replaces the status meeting — you can see in 30 seconds whether coverage is healthy or something broke overnight."

*Why it lands: gives the QA Lead / Head of Mobile a single pane they can check before standup.*

---

**Screen 4 — Agent Heartbeat in Action** (~2 min)

Click into a specific agent (e.g., the smoke-test agent). Show the last heartbeat output.

> "Each agent runs on a schedule — it checks your test suite, flags flaky tests, updates the regression plan. No human triggers it."

If you have a recent output showing a flagged test or a regression pattern: show it.

*Why it lands: it's not a dashboard with stale data — it's live work being done. Engineers trust things that show their work.*

---

**Screen 5 — Smoke Test Output / Regression Report** (~2 min)

Show a concrete output artifact — a smoke-test run result, a regression coverage plan, or a release checklist.

> "This is what your QA Lead would get after each sprint cycle — here's what's covered, what's missing, where the risk is. All generated from your actual codebase, no templates."

*Why it lands: VP Eng cares about coverage gaps. This is the artifact they'd show their CTO to justify the spend.*

---

## Value lock (3 min)

**Confirm ROI:**
> "Based on what you told me earlier — [their sprint QA estimate, e.g., '2 engineers half-time'] — what would it mean to your team if that was automated and running every PR, not just pre-release?"

*Let them do the math. Don't fill the silence.*

**If they're vague, anchor it:**
> "Most mobile teams we talk to spend 15-20% of a sprint on manual QA. For a 5-person eng team, that's one engineer's time. At $150K loaded cost, that's $25K/year on manual regression. This pays for itself in the first month."

**The "prove it" objection** — if they say "we'd need to validate it on our actual codebase":
> "That's exactly what the design-partner program is for — you connect it to your real GitHub repo on Day 1 and we run it against your actual PRs for 90 days. If it doesn't catch real regressions, you cancel. No annual commitment."

---

## Close (4 min)

**Transition:**
> "I want to be transparent with you — we're selective about who we bring in as design partners. We're working with three teams right now and have room for one more. I'd rather say no to the wrong fit than yes to everyone."

**The offer:**
> "Design-partner terms: $299/month, pro-equivalent access, rate locked for 12 months. We do a guided Day 1 onboarding — 45 minutes, I'm on the call, your team goes live by the end of it. 14-day trial before the first invoice, no card required to start."

**The scarcity signal (natural, not pushy):**
> "We have one design-partner slot left for this cohort. I'm talking to a couple of other teams this week — I'm not trying to pressure you, but if this is a fit I want to give you first right of refusal before I move on."

**The close question:**
> "Does $299/month fit your evaluation budget to run a 90-day real-world test on this?"

*Wait. Do not talk.*

**If yes:** "Great — I'll send you the booking link right now — you can pick a 45-minute Day 1 onboarding slot directly. Trial starts the moment you book, no card required."

*Send: `https://cal.com/wavex/design-partner` — or paste the link into chat if screen-sharing. If the link is unavailable, tell them you'll follow up with a calendar invite within the hour and do it immediately post-call.*

**If "we need to involve someone else":** "Totally reasonable. Who else needs to see this? I can do a 20-minute replay for them this week, or I can send you a recording of this session."

---

## Objection table

| Objection | Response |
|-----------|----------|
| **"We have an internal QA team / SDET team"** | "This isn't replacing them — it's removing the repetitive part of their job. How much of their time is running the same regression suite every sprint? This handles that. They focus on new coverage." |
| **"Too early for us / we're pre-launch"** | "Pre-launch is actually the best time. You're building coverage habits before tech debt locks in. Design partners who start before launch have better baselines at v1.0 than anyone who backfills QA later." |
| **"We use Appium / Detox / BrowserStack"** | "We don't replace those — we orchestrate on top of them. If you're already running Detox, this adds the agent layer that decides *what* to run, *when*, and flags *what's missing*. Your Detox investment stays." |
| **"We need to talk to our CTO"** | "Makes sense. Want me to do a 15-minute CTO-specific version? I can focus on architecture, security posture, and data flow — the things a CTO will ask first. I can join a call with them this week." |

---

*Grounded in: [WAVAAAA-418](/WAVAAAA/issues/WAVAAAA-418) demo readiness brief, [WAVAAAA-346](/WAVAAAA/issues/WAVAAAA-346) pricing brief (CEO-approved 2026-05-18), [WAVAAAA-427](/WAVAAAA/issues/WAVAAAA-427) onboarding spec, product README at `packages/tony-apple-qa/README.md`.*

---

> **Cal.com status (as of 2026-05-19):** `CALENDAR_HREF = 'cal.com/wavex/design-partner'` is a placeholder — not yet confirmed live ([WAVAAAA-120](/WAVAAAA/issues/WAVAAAA-120)). Until confirmed: send prospects a direct calendar invite post-call. Do not display the raw cal.com URL on the LP or in written follow-ups until the link is validated.
