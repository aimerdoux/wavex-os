# Inference Hook Manager — v1 (2026-06-10)

**The thesis (Pool B):** Paperclip should not be a lonely child. Every internal
event — errors, blockers, breaker trips, completions — lands on a surface of
inference that can optimize and fix in-flight, instead of dying in logs. Hook
activations are the metering unit of the Pool B inference business model.

## v1 (shipped)

- `packages/core/server/src/services/inference-hooks.ts`
- **Events wired:** `run_failed` + `run_completed` (at `setRunStatus`, the single
  terminal-state chokepoint) and `breaker_paused` (run governor). Every event is
  activity-logged as `inference_hook.<type>` (visible in the dashboard stream).
- **Actuator:** a configurable FIXER agent woken through the normal wakeup queue —
  so the run governor still gates hook-triggered work against the quota window.
- **Storm-proofing (lessons from the 2026-06-10 audits):** 30-min per-signature
  dedup, global wakes/hour cap, fixer's own runs never re-trigger hooks,
  transient error codes ignorable, fire-and-forget (a hook can never take down
  the host path).
- **Config (hot-read, no restart):** `~/.paperclip/instances/default/inference-hooks.json`
  — currently: enabled, fixer = CPO/QA (`9c9943f6…`), 4 wakes/hr,
  ignore `claude_transient_upstream` + `process_lost`, completions off.

## v2 (scoped, not built)

1. Persistent `hook_events` table + Mission Control "Hooks" tab (fires, fixes,
   MTTR) — the Pool B billing meter reads from here.
2. Per-hook playbooks: match on `errorCode`/agent/issue patterns → distinct
   fixer prompts (e.g. connector failures route to a credentials playbook).
3. Cross-process ingestion: wavex-os-server (Composio failures, port 3101) and
   edge functions POST events to a core `/api/hooks/emit` endpoint —
   connector_failed is declared in v1 but only emittable in-process today.
4. Completion hooks for optimization loops (post-success review/upsell triggers).
5. Outcome feedback: fixer posts `fixed|escalated|noop` so hook efficacy is measurable.
