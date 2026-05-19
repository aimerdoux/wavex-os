# tony-apple-qa

[![npm version](https://img.shields.io/npm/v/tony-apple-qa)](https://www.npmjs.com/package/tony-apple-qa)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)
[![CI](https://github.com/aimerdoux/wavex-os/actions/workflows/ci.yml/badge.svg)](https://github.com/aimerdoux/wavex-os/actions)

**Tony Apple QA** is an AI-powered QA operating system for mobile-app teams. Answer five questions about your app and go-to-market, and the wizard spins up a full QA agent fleet on your laptop — smoke tests, regression coverage plans, release checklists, and a Mission Control dashboard — all running locally on your Claude Max subscription, no API keys required.

## Install

```bash
npm install -g tony-apple-qa
tony-apple-qa init
```

## Quick evaluation (pre-npm)

If the npm package isn't published yet, evaluate directly from source:

```bash
git clone https://github.com/aimerdoux/wavex-os.git
cd wavex-os
npm install -g pnpm   # if pnpm is not installed
pnpm install
pnpm dev:no-paperclip  # starts the onboarding wizard at http://localhost:5173
```

## Quick start

1. Install the CLI above.
2. Run `tony-apple-qa init` — this opens the onboarding wizard in your browser.
3. Answer the five pillars (who you are, your Claude setup, your product stage, GTM motion, and notification channel).
4. Let the wizard generate your QA agent roster and workflow plan.
5. Click **Activate fleet** — your agents go live immediately.

## Commands

| Command | What it does |
|---|---|
| `tony-apple-qa init` | Run the onboarding wizard |
| `tony-apple-qa doctor` | Check prerequisites (Node, pnpm, Claude CLI) |
| `tony-apple-qa audit` | Disk, RAM, ports, launchd health check |
| `tony-apple-qa login` | Pair this machine with the cloud console |
| `tony-apple-qa status` | Show local pairing state |
| `tony-apple-qa logout` | Remove the local device token |

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md).

## License

MIT
