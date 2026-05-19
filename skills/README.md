# WaveX OS — Skills

Reusable agent capabilities for [WaveX OS](https://github.com/aimerdoux/wavex-os), packaged for the [skills.sh](https://skills.sh) ecosystem.

Each skill is invokable by Claude Code (and any other harness that follows the [skills CLI](https://github.com/vercel-labs/skills) discovery conventions). They drive real user-facing operations against a local WaveX OS install — they do **not** modify the agent runtime itself.

## Install all six

```bash
npx skills add aimerdoux/wavex-os
```

Or pick individual skills:

```bash
npx skills add aimerdoux/wavex-os@wavex-os-init
```

## Skills

| Skill | What it does |
|---|---|
| [wavex-os-init](./wavex-os-init/SKILL.md) | Install + run the 5-pillar wizard end-to-end. Canonical entry point. |
| [wavex-os-audit](./wavex-os-audit/SKILL.md) | Run `doctor` + `audit` diagnostics — disk, RAM, ports, launchd, services, Claude CLI. |
| [wavex-os-provision-company](./wavex-os-provision-company/SKILL.md) | Drive a 2nd-or-later company through the wizard on an existing install. |
| [wavex-os-mission-control](./wavex-os-mission-control/SKILL.md) | Read-only inspector — KPIs, bottlenecks, decision queue, budget, activity. |
| [wavex-os-debug-healing](./wavex-os-debug-healing/SKILL.md) | Walk the 3-layer self-heal flow (401 fallback / OAuth refresh / worker restart) when stalled. |
| [wavex-os-activate-and-ignite](./wavex-os-activate-and-ignite/SKILL.md) | Activate a signed manifest + ignite first tasks after the wizard finishes. |

## Scope

These skills assume:

- WaveX OS is installed locally (`npm install -g wavex-os-installer`)
- The local server is reachable at `http://localhost:3101`
- The UI is reachable at `http://localhost:5173` (when applicable)
- `WAVEX_AUTH_MODE=dev` (default) — production deployments need to wire Better-Auth before these skills work unmodified

For the agent-runtime skills loaded into agent prompts at heartbeat (e.g. `SKILL_VERIFY_BEFORE_CLAIM`, `SKILL_KERNEL_LESSONS`), see [`packages/onboarding-ui/public/agent-templates/_shared/`](../packages/onboarding-ui/public/agent-templates/_shared/) and [`packages/standard-skills/`](../packages/standard-skills/) instead. Those are loaded by the wizard at handoff time and are not invokable from outside.

## Contributing

Skill PRs welcome. Each skill must:

1. Live under `skills/<name>/SKILL.md` with `name` + `description` in YAML frontmatter
2. Reference only real CLI commands and HTTP routes (greppable in this repo)
3. Include preconditions, procedure, success criteria, and common failure modes
4. Not touch any [frozen path](../CLAUDE.md#frozen-paths-do-not-modify)
