# Contributing to WaveX OS / Tony Apple QA

Thanks for considering a contribution. WaveX OS is in active development; the easiest way to help is to clone, run, and report what breaks.

Looking for something to work on? Browse [good first issues](https://github.com/aimerdoux/wavex-os/issues?q=is%3Aopen+label%3A%22good+first+issue%22).

---

## Local dev setup

```bash
git clone https://github.com/aimerdoux/wavex-os.git
cd wavex-os
npm install -g pnpm   # if you don't have pnpm yet
pnpm install
pnpm test             # run the test suite
pnpm dev              # runs onboarding-ui + mock-core in parallel
```

Open [http://localhost:5173](http://localhost:5173) — you'll land on Mission Control.

To work on individual packages:

```bash
pnpm dev:ui       # just the onboarding wizard
pnpm dev:core     # just the mock-core server
```

---

## Branch naming

```
feat/<short-description>        # new feature
fix/<short-description>         # bug fix
docs/<short-description>        # documentation only
chore/<short-description>       # tooling, deps, config
```

Examples: `feat/pillar-6-form`, `fix/port-collision`, `docs/contributing-guide`

---

## Repo layout

| Path | What it is |
|---|---|
| `apps/installer/` | `npx wavex-os init` CLI |
| `packages/agent-templates/` | Curated role templates plus `_registry.json` |
| `packages/auth-shim/` | Auth boundary gates (`assertBoard`, `assertCompanyAccess`) via `WAVEX_AUTH_MODE` |
| `packages/claude-code-proxy/` | Local Anthropic-compatible proxy bridged through Supabase Realtime |
| `packages/cloud-client/` | Cloud API + Realtime client for device link/token + inference routing |
| `packages/composio-shim/` | Composio onboarding surface (`listConnections`, toolkits, key validation) |
| `packages/core/` | Paperclip vendored via git subtree (don't modify directly - see below) |
| `packages/db/` | Drizzle schema + PGlite/Postgres adapters + migrations |
| `packages/healing/` | Self-healing loops (401 fallback, refresh lock, worker restart) |
| `packages/inference-adapter/` | Tier-router inference mode switch (`oauth`/`apikey`) |
| `packages/inference-server/` | Mac-hosted Fastify inference proxy for Pool A/C |
| `packages/mock-core/` | In-memory Paperclip stand-in (Fastify on :3101) |
| `packages/observability/` | Fleet observability reference package (bottlenecks, attribution, token budget) |
| `packages/onboarding-server-client/` | Typed client for future hosted onboarding backend |
| `packages/onboarding-ui/` | Browser onboarding wizard + Mission Control UI |
| `packages/paperclip-plugin-wavex/` | WaveX plugin layer for Paperclip dashboard/workflow |
| `packages/plugin-sdk-shim/` | Re-export shim for `@paperclipai/plugin-sdk` |
| `packages/standard-skills/` | Shared cross-cutting skill packs loaded by agents |
| `packages/tony-apple-qa/` | CLI package for QA-fleet setup flow |
| `packages/wavex-os-server/` | Fastify route adapter for vendored onboarding plugin |
| `scripts/wrappers/claude-anthropic-direct.sh` | Claude Max OAuth wrapper |
| `scripts/ingest-agency-agents.mjs` | Re-runnable upstream → curated template ingester |
| `docs/` | Architecture, OAuth handoff design, roadmap |

---

## Where to start

| You want to… | Look at |
|---|---|
| Improve a wizard step | `packages/onboarding-ui/src/wavex-os/{pillars,phases,pages}/` |
| Improve Mission Control | `packages/onboarding-ui/src/components/mission/` and `packages/onboarding-ui/src/pages/MissionControl.tsx` |
| Add or refine a template | `packages/agent-templates/<id>/SKILL.md` and `_registry.json` |
| Improve the mock backend | `packages/mock-core/src/server.ts` |
| Touch the OAuth wrapper | `scripts/wrappers/claude-anthropic-direct.sh` |
| Update the architecture | `docs/ARCHITECTURE.md` |

---

## Conventions

### Commit message format

Follow [Conventional Commits](https://www.conventionalcommits.org/) with an area tag:

```
feat(<area>): short description
fix(<area>): short description
docs(<area>): short description
chore(<area>): short description
test(<area>): short description
```

Examples:

```
feat(wizard): add pillar-6 mobile-test-runner form
fix(installer): handle missing pnpm gracefully
docs(contributing): add branch naming guide
```

The subject line must be ≤72 characters. Use the body for "why", not "what".

### TypeScript
Every package uses strict TypeScript. Before pushing:
```bash
pnpm --filter @wavex-os/onboarding-ui exec tsc --noEmit
pnpm --filter @wavex-os/mock-core exec tsc -p tsconfig.json
```
The CI for individual packages should pass `tsc --noEmit` and `vite build` (UI) cleanly.

### Bash
The wrapper script (`scripts/wrappers/*.sh`) is `set -euo pipefail` strict bash. Test on macOS at minimum; Linux/Windows paths land in Phase F.

### Templates
Agent templates ship under `packages/agent-templates/<id>/SKILL.md`. They are PII-scrubbed at ingest time (see `scripts/ingest-agency-agents.mjs`). If you modify a template, run a fresh `grep -RInE 'sk-[A-Za-z0-9]+|<your-email>|/Users/'` over the directory before commit.

### Paperclip subtree
`packages/core/` is a git subtree of [paperclip-ai/paperclip](https://github.com/paperclipai/paperclip). Do **not** edit files there directly. To pull upstream changes:

```bash
git remote add paperclip-upstream https://github.com/paperclipai/paperclip.git
git subtree pull --prefix=packages/core paperclip-upstream master --squash
```

WaveX-specific patches to core land in `patches/` and are applied at build time (Phase D will formalize this).

---

## Security

If you find a security issue (credential leakage, RCE, prototype pollution, etc.), please **do not file a public issue**. Email security concerns directly until we publish a `SECURITY.md`. We treat secret-scanning regressions as P0.

The repo has a hardened `.gitignore` for `.env*`, `*.pem`, `*.key`, `secrets.json`, `~/.paperclip/`, `.claude/projects/`, and similar paths. **Never commit a real Anthropic key, Telegram bot token, Composio token, or Stripe key.** The wrapper's `WAVEX_CLAUDE_STUB=1` gives you a working synthetic credential for plumbing tests.

---

## Pull requests

1. Fork the repo and create a branch following the naming convention above.
2. Make your change. Match the existing code style (no new linters or formatters in a PR — that's a separate change).
3. Run `pnpm test` and ensure it passes.
4. Ensure type-check passes on every package you touched (`pnpm --filter <package> exec tsc --noEmit`).
5. If you changed UX, add a 1–2 sentence note in the PR description on what the user now sees.
6. Open the PR against `main`.
7. Link the issue your PR closes (`Closes #123`).

**PR checklist:**
- [ ] `pnpm test` passes
- [ ] TypeScript compiles cleanly on changed packages
- [ ] Frozen paths untouched (see CLAUDE.md)
- [ ] No plaintext secrets or keys committed

For substantial changes (new package, architectural refactor, new dependency >100KB), open a discussion or issue first — the maintainer will tell you if it fits the roadmap before you sink hours.

Need a starting point? Browse [good first issues](https://github.com/aimerdoux/wavex-os/issues?q=is%3Aopen+label%3A%22good+first+issue%22).

---

## Roadmap input

The phase plan is in [docs/ROADMAP.md](docs/ROADMAP.md). If you have a feature request:

- **In-roadmap:** check off an unchecked item via PR.
- **Out-of-roadmap:** open an issue with the rationale and which phase it would slot into. We default to "subtractive" — we cut more than we add — so make the case clearly.

---

## Code of Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Short version: be kind, disagree on technical merit, and treat every contributor with respect.
