# Watchdogs And Execution Contracts

Status: Draft  
Date: 2026-05-28  
Audience: Product + Engineering  
Scope: Run accountability, deliverable guarantees, deviation detection, and
controlled multi-runtime fallback

## 1. Why this exists

Paperclip already has strong runtime primitives:

- `heartbeat_runs` for execution state
- `heartbeat_run_events` for evidence
- `heartbeat_run_watchdog_decisions` for bounded overrides
- `deliverables` for proof of work
- `requestWakeup(s)` for controlled actuation
- recovery services for silent runs, stranded issues, and retry storms

What is still missing is the contract layer that answers:

1. What was this task expected to produce?
2. Which runtime/profile was allowed to execute it?
3. What counts as a deviation?
4. Which watchdog subscribes to that deviation?
5. What is the bounded automatic response?

This spec defines that abstraction.

## 2. Design goals

1. No silent failures.
2. No invisible retries or invisible cost burn.
3. Every successful task must have proof, validation, or escalation.
4. Multiple runtime profiles can coexist intentionally:
   - Claude stable
   - Claude preview/alternate version
   - Codex backup
5. Watchdog actions must respect existing host controls:
   - budgets
   - wakeup policy
   - assignment ownership
   - pause holds
   - recovery issue lineage

## 3. Core concepts

### 3.1 Execution profile

An execution profile is a named runtime policy for how a task is attempted.

Examples:

- `claude-stable`
- `claude-preview`
- `claude-heavy-research`
- `codex-backup`

Each profile defines:

- adapter family (`claude_local`, `codex_local`, etc.)
- model
- optional channel/version hint
- retry / fallback policy
- metadata for governance and UI

Profiles are reusable. Tasks should point at profiles, not raw provider strings.

### 3.2 Execution contract

An execution contract binds an expected outcome to a scope.

Scopes may include:

- issue
- agent
- workflow step
- goal

The contract declares:

- allowed execution profiles
- fallback profile, if any
- expected deliverables
- freshness/latency SLA
- validators
- escalation owner + wake reason
- automatic retry ceiling

The contract is the source of truth for “what good looks like.”

### 3.3 Watchdog signal

A watchdog signal is normalized evidence that something notable happened or did
not happen.

Examples:

- run is silent too long
- run failed
- run succeeded but expected deliverable is missing
- deliverable exists but validation failed
- budget threshold crossed
- cost slope deviated from baseline

Signals should be normalized enough that both core-runtime and WaveX-specific
policy can reason over them.

### 3.4 Watchdog rule

A watchdog rule subscribes to one or more signal types and decides whether to
emit one or more bounded actions.

Rules should not directly mutate arbitrary task content. They should produce
decisions such as:

- create evaluation issue
- request issue wakeup
- switch execution profile
- pause agent
- pause fleet
- escalate to owner role
- snooze

### 3.5 Watchdog decision

A watchdog decision is the durable output of a rule evaluation.

It should be explainable:

- which rule fired
- which contract applied
- what evidence triggered it
- what action was chosen
- whether a human or agent overrode/snoozed it later

This is where `heartbeat_run_watchdog_decisions` already gives us a strong
precedent for run-level cases.

## 4. Architecture shape

The abstraction sits above existing runtime services:

1. existing runtime emits run state and run evidence
2. contract resolver finds the applicable execution contract
3. watchdog registry selects rules subscribed to the signal
4. rules emit normalized actions
5. host-owned services execute those actions through safe pathways

Important: the watchdog layer is decisioning, not direct process control.
Actual execution still goes through existing host services.

## 5. Event channels

Use both:

### 5.1 Event-driven channels

For fast reaction:

- `agent.run.failed`
- `activity.logged`
- `budget.incident.opened`
- `cost_event.created`
- deliverable/activity events

### 5.2 Periodic scans

For absence-based failures:

- silent active runs
- issue completed with no deliverable
- validation overdue
- fallback rate anomaly
- conversation/context growth anomaly

The existing active-run watchdog is the model here: not every failure has a
single event edge.

## 6. Default rule families

### 6.1 Run liveness watchdog

Purpose:

- detect active runs that have stopped producing useful output

Typical actions:

- create evaluation issue
- request recovery owner wakeup
- escalate when critical silence crosses the higher threshold

This should build on the existing silent-run watchdog, not replace it.

### 6.2 Deliverable missing watchdog

Purpose:

- detect “run says success” or “issue says done” but expected proof is missing

Typical actions:

- create evaluation issue
- wake original assignee or validator
- mark contract as violated

This is the main bridge between runtime correctness and artifact correctness.

### 6.3 Deliverable validation watchdog

Purpose:

- detect artifacts that exist but fail schema/tests/review/semantic validators

Typical actions:

- open validator/recovery issue
- request assignment wakeup for the producing issue
- block dependent approvals

### 6.4 Quota and cost watchdog

Purpose:

- prevent runaway burn, invisible fallback churn, or exhausted-provider storms

Typical actions:

- switch to backup execution profile when policy allows
- pause agent or fleet on hard ceilings
- open operator-facing issue when fallback surge exceeds threshold

This is where Claude-primary / Codex-backup governance lives.

### 6.5 Context-growth watchdog

Purpose:

- catch conversations/issues whose context cost keeps compounding

Typical actions:

- request summarization/compression step
- switch to cheaper profile when contract allows
- escalate when cost slope exceeds budget

## 7. Multi-runtime policy

This abstraction is explicitly meant to support intentional overlap between
multiple Claude variants and Codex backup.

Recommended shape:

- primary profile:
  `claude-stable`
- alternate Claude profile:
  `claude-preview`
- backup profile:
  `codex-backup`

Recommended governance:

- fallback should be opt-in per contract
- backup profile activation must be attributable
- provider fallback should be queryable by issue/run/session
- hard budget incidents may pause work instead of falling back if the contract
  forbids model/provider changes

## 8. Safety rules

1. Watchdogs should fail closed on observability loss when the action is
   safety-critical.
2. Watchdogs must never create infinite retry loops.
3. Watchdogs must not silently rewrite deliverables.
4. Automatic actions must be bounded and reversible.
5. Every automatic action should leave durable evidence.

## 9. Implementation plan

Phase 1:

- add typed execution-profile, execution-contract, signal, rule, and decision
  scaffolding
- add a registry + contract resolver
- add default rule shapes:
  - run liveness
  - deliverable missing
  - quota/cost

Phase 2:

- wire the registry into existing runtime/recovery event sources
- persist rule evaluations
- add UI surfaces for contract + watchdog state

Phase 3:

- integrate validator pipelines and conversation/context optimization
- add company-configurable watchdog policies

## 10. Non-goals for this slice

- full runtime integration
- UI implementation
- new autonomous remediation behavior beyond existing safe host actions
- provider-specific streaming chunk accounting changes

This slice should establish the abstraction, not finish the whole runtime.
