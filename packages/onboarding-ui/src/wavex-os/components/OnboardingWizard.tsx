/** 3-step onboarding wizard shell (WAVAAAA-48, WAVAAAA-54).
 *
 *  Steps 1–2: static orientation screens.
 *  Step 3:    interactive first smoke test runner — triggers a test run,
 *             polls live phase updates every 5 s, shows a celebration screen
 *             on pass, and falls back to an email-confirmation state at 5 min.
 *
 *  Renders as a full-screen overlay when is_new_user=true.
 *  Skipped entirely for returning users.
 *  Current step is persisted to the backend so a refresh resumes correctly. */

import { useCallback, useEffect, useRef, useState } from "react";
import { userApi, smokeTestApi, type SmokeTestPhase } from "../lib/api";
import { Step2PlatformCard, type PlatformTarget } from "./Step2PlatformCard";
import { GitHubRepoStep } from "./GitHubRepoStep";

const TOTAL_STEPS = 3;

const STEPS = [
  {
    title: "Connect your repo",
    body: "",
  },
  {
    title: "Connect your workspace",
    body: "Configure your agents, connect your tools, and define how your AI fleet will operate.",
  },
  {
    title: "Run your first smoke test",
    body: "",
  },
];

function wizardDocumentTitle(step: number): string {
  return `WaveX OS — ${STEPS[step - 1]?.title ?? "Onboarding"}`;
}

// ─── step 3 sub-state ────────────────────────────────────────────────────────

type Step3Kind = "idle" | "running" | "done" | "timed_out" | "aborted";

interface Step3State {
  kind: Step3Kind;
  runId?: string;
  phase?: SmokeTestPhase;
  result?: "pass" | "fail";
}

const PHASE_LABELS: Record<SmokeTestPhase, string> = {
  queued:       "Queued — waiting to start",
  provisioning: "Provisioning test environment",
  running:      "Running smoke test",
  analyzing:    "Analyzing results",
  done:         "Test complete",
  timed_out:    "Still running",
  cancelled:    "Cancelled",
};

// ─── step 2 persistence ──────────────────────────────────────────────────────

const LS_KEY = "wavex_wizard_platform_target";

function loadPlatformTarget(): PlatformTarget {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PlatformTarget>;
      return { platform: parsed.platform ?? null, identifier: parsed.identifier ?? "", file: null };
    }
  } catch { /* ignore */ }
  return { platform: null, identifier: "", file: null };
}

function savePlatformTarget(t: PlatformTarget) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ platform: t.platform, identifier: t.identifier }));
  } catch { /* ignore */ }
}

function fireWizardEvent(userId: string, payload: Record<string, unknown>): void {
  fetch("/api/wizard-events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, ...payload, ts: new Date().toISOString() }),
  }).catch(() => {});
}

// ─── step 3 component ────────────────────────────────────────────────────────

function Step3({
  userId,
  companyId,
  platformTarget,
  onComplete,
}: {
  userId: string;
  companyId?: string;
  platformTarget: PlatformTarget;
  onComplete: () => void;
}) {
  const [state, setState] = useState<Step3State>({ kind: "idle" });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Poll every 5s while a run is in-flight
  useEffect(() => {
    if (state.kind !== "running" || !state.runId) return;

    const runId = state.runId;

    const poll = async () => {
      try {
        const res = await smokeTestApi.getStatus(runId);
        if (res.phase === "done") {
          stopPolling();
          fireWizardEvent(userId, { eventType: "first_test_result", resultId: runId, status: res.result });
          setState({ kind: "done", runId, result: res.result });
        } else if (res.phase === "timed_out") {
          stopPolling();
          setState({ kind: "timed_out", runId });
        } else if (res.phase === "cancelled") {
          stopPolling();
          setState({ kind: "aborted" });
        } else {
          setState((prev) => ({ ...prev, phase: res.phase }));
        }
      } catch {
        // transient — keep polling
      }
    };

    poll(); // immediate first tick
    pollRef.current = setInterval(poll, 5_000);
    return stopPolling;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind, state.runId]);

  // When aborted, advance to dashboard immediately
  useEffect(() => {
    if (state.kind === "aborted") onComplete();
  }, [state.kind, onComplete]);

  const handleRunTest = useCallback(async () => {
    const effectiveCompanyId = companyId ?? "default";
    try {
      const res = await smokeTestApi.trigger(effectiveCompanyId, userId);
      fireWizardEvent(userId, { eventType: "wizard_complete", step: 3 });
      setState({ kind: "running", runId: res.runId, phase: "queued" });
    } catch {
      // surface inline — caller can retry
      setState({ kind: "idle" });
    }
  }, [companyId, userId]);

  const handleAbort = useCallback(async () => {
    if (!state.runId) return;
    stopPolling();
    try { await smokeTestApi.abort(state.runId); } catch { /* best-effort */ }
    setState({ kind: "aborted" });
  }, [state.runId, stopPolling]);

  // ── idle: summary card + CTA ───────────────────────────────────────────────
  if (state.kind === "idle") {
    return (
      <div style={{ maxWidth: 480, width: "100%", padding: "2rem", textAlign: "center" }}>
        <h1 style={{ fontSize: 26, marginBottom: "0.75rem", letterSpacing: "-0.02em" }}>
          Run your first smoke test
        </h1>
        <p style={{ color: "var(--text-dim)", fontSize: 15, lineHeight: 1.6, marginBottom: "1.75rem" }}>
          We'll verify your WaveX OS instance end-to-end before handing off to your fleet.
        </p>

        {/* Summary card */}
        <div style={{
          background: "var(--bg-subtle, rgba(255,255,255,0.05))",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: "1rem 1.25rem",
          marginBottom: "1.75rem",
          textAlign: "left",
          fontSize: 13,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
            <span style={{ color: "var(--text-dim)" }}>Project</span>
            <span style={{ fontWeight: 500 }}>WaveX OS</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "var(--text-dim)" }}>Test target</span>
            <span style={{ fontWeight: 500 }}>
              {platformTarget.platform && platformTarget.identifier
                ? `${platformTarget.platform === "ios" ? "iOS" : "Android"} — ${platformTarget.identifier}`
                : "Chat smoke — end-to-end connectivity"}
            </span>
          </div>
        </div>

        <div style={{ marginBottom: "0.75rem" }}>
          <button style={{ minWidth: 220 }} onClick={handleRunTest}>
            Run my first smoke test →
          </button>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>Estimated time: ~3 minutes</div>
      </div>
    );
  }

  // ── running: live phase ticker ─────────────────────────────────────────────
  if (state.kind === "running") {
    const phases: SmokeTestPhase[] = ["queued", "provisioning", "running", "analyzing"];
    const currentIdx = phases.indexOf(state.phase ?? "queued");

    return (
      <div style={{ maxWidth: 420, width: "100%", padding: "2rem", textAlign: "center" }}>
        <h1 style={{ fontSize: 24, marginBottom: "0.5rem", letterSpacing: "-0.02em" }}>
          Running smoke test
        </h1>
        <p style={{ color: "var(--text-dim)", fontSize: 14, marginBottom: "2rem" }}>
          Estimated time: ~3 minutes
        </p>

        {/* Phase ticker */}
        <div style={{ marginBottom: "2rem", textAlign: "left" }}>
          {phases.map((phase, idx) => {
            const done    = idx < currentIdx;
            const active  = idx === currentIdx;
            const pending = idx > currentIdx;
            return (
              <div key={phase} style={{
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
                padding: "0.5rem 0",
                opacity: pending ? 0.4 : 1,
              }}>
                <div style={{
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11,
                  background: done
                    ? "var(--accent)"
                    : active
                      ? "transparent"
                      : "var(--border)",
                  border: active ? "2px solid var(--accent)" : "none",
                  animation: active ? "spin 1s linear infinite" : "none",
                }}>
                  {done && "✓"}
                </div>
                <span style={{
                  fontSize: 14,
                  fontWeight: active ? 600 : 400,
                  color: active ? "var(--text)" : "var(--text-dim)",
                }}>
                  {PHASE_LABELS[phase]}
                </span>
              </div>
            );
          })}
        </div>

        <button
          className="secondary"
          onClick={handleAbort}
          style={{ fontSize: 12, padding: "0.4rem 1rem" }}
        >
          Abort test
        </button>
      </div>
    );
  }

  // ── done: celebration screen ───────────────────────────────────────────────
  if (state.kind === "done") {
    return (
      <div style={{ maxWidth: 420, width: "100%", padding: "2rem", textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: "1rem" }}>🎉</div>
        <h1 style={{ fontSize: 26, marginBottom: "0.75rem", letterSpacing: "-0.02em" }}>
          All systems go!
        </h1>
        <p style={{ color: "var(--text-dim)", fontSize: 15, lineHeight: 1.6, marginBottom: "2rem" }}>
          Your smoke test passed. Your WaveX OS fleet is ready to run.
        </p>
        <button onClick={onComplete}>
          Continue to dashboard →
        </button>
      </div>
    );
  }

  // ── timed_out: email fallback ──────────────────────────────────────────────
  if (state.kind === "timed_out") {
    return (
      <div style={{ maxWidth: 420, width: "100%", padding: "2rem", textAlign: "center" }}>
        <div style={{ fontSize: 40, marginBottom: "1rem" }}>⏳</div>
        <h1 style={{ fontSize: 24, marginBottom: "0.75rem", letterSpacing: "-0.02em" }}>
          Still running
        </h1>
        <p style={{ color: "var(--text-dim)", fontSize: 15, lineHeight: 1.6, marginBottom: "2rem" }}>
          Your smoke test is taking longer than expected. We'll email you when it completes — go
          ahead and explore the dashboard in the meantime.
        </p>
        <button onClick={onComplete}>
          Go to dashboard →
        </button>
      </div>
    );
  }

  return null;
}

// ─── main wizard shell ───────────────────────────────────────────────────────

export function OnboardingWizard() {
  const [userId, setUserId] = useState<string | null>(null);
  const [companyId, setCompanyId] = useState<string | undefined>(undefined);
  const [step, setStep] = useState(1);
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [platformTarget, setPlatformTarget] = useState<PlatformTarget>(loadPlatformTarget);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);

  useEffect(() => {
    userApi.me()
      .then((res) => {
        if (res.user.isNewUser) {
          setUserId(res.user.id);
          setStep(Math.min(Math.max(res.user.wizardStep ?? 1, 1), TOTAL_STEPS));
          setSelectedRepo(res.user.wizardRepo ?? null);
          setVisible(true);
        }
      })
      .catch(() => {
        // /api/users/me unavailable (e.g. dev without mock-core) — skip wizard.
      })
      .finally(() => setLoading(false));

    // Best-effort: read companyId from URL search params (set by CompanyContext)
    const urlCompanyId = new URLSearchParams(window.location.search).get("companyId");
    if (urlCompanyId) setCompanyId(urlCompanyId);
  }, []);

  const persist = useCallback(async (nextStep: number) => {
    if (!userId) return;
    setSaving(true);
    try {
      await userApi.setWizardStep(userId, nextStep);
      setStep(nextStep);
    } finally {
      setSaving(false);
    }
  }, [userId]);

  const handleRepoSelected = useCallback(async (repo: string) => {
    setSelectedRepo(repo || null);
    if (userId && repo) {
      try { await userApi.setWizardRepo(userId, repo); } catch { /* best-effort */ }
    }
  }, [userId]);

  const step1Valid = Boolean(selectedRepo);
  const step2Valid =
    platformTarget.platform !== null && platformTarget.identifier.trim().length > 0;

  useEffect(() => {
    if (!visible) return;
    document.title = wizardDocumentTitle(step);
    return () => {
      document.title = "WaveX OS";
    };
  }, [step, visible]);

  const handleNext = useCallback(async () => {
    if (step === 2) savePlatformTarget(platformTarget);
    if (step < TOTAL_STEPS) {
      await persist(step + 1);
    }
    // Step 3 completion is handled by the Step3 sub-component calling onComplete.
  }, [step, persist, platformTarget]);

  const handleBack = useCallback(async () => {
    if (step > 1) await persist(step - 1);
  }, [step, persist]);

  const handleComplete = useCallback(async () => {
    if (!userId) return;
    setSaving(true);
    try {
      await userApi.completeWizard(userId);
      setVisible(false);
    } finally {
      setSaving(false);
    }
  }, [userId]);

  if (loading || !visible) return null;

  const progressPct = Math.round((step / TOTAL_STEPS) * 100);
  const current = STEPS[step - 1];

  return (
    <div style={{
      position: "fixed",
      inset: 0,
      background: "var(--bg)",
      zIndex: 1000,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
    }}>
      {/* Top progress bar */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "var(--border)" }}>
        <div style={{
          height: "100%",
          width: `${progressPct}%`,
          background: "var(--accent)",
          transition: "width 300ms ease",
        }} />
      </div>

      {/* Step dots */}
      <div style={{ position: "absolute", top: 20, display: "flex", gap: 8 }}>
        {Array.from({ length: TOTAL_STEPS }, (_, i) => (
          <div key={i} style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: i < step ? "var(--accent)" : "var(--border)",
            transition: "background 300ms",
          }} />
        ))}
      </div>

      {/* Step label */}
      <div style={{ position: "absolute", top: 38, fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.1em" }}>
        Step {step} of {TOTAL_STEPS}
      </div>

      {/* Step content */}
      {step === TOTAL_STEPS ? (
        /* Step 3: interactive smoke test runner */
        userId && (
          <Step3
            userId={userId}
            companyId={companyId}
            platformTarget={platformTarget}
            onComplete={handleComplete}
          />
        )
      ) : step === 2 ? (
        /* Step 2: iOS/Android platform selector + app identifier */
        <div style={{ maxWidth: 480, width: "100%", padding: "2rem" }}>
          <h1 style={{ fontSize: 24, marginBottom: "1.5rem", letterSpacing: "-0.02em" }}>
            Pick your test target
          </h1>
          <div style={{ marginBottom: "2rem" }}>
            <Step2PlatformCard value={platformTarget} onChange={setPlatformTarget} />
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <button className="secondary" onClick={handleBack} disabled={saving}>
              ← Back
            </button>
            <button onClick={handleNext} disabled={saving || !step2Valid}>
              {saving ? "Saving…" : "Next →"}
            </button>
          </div>
        </div>
      ) : (
        /* Step 1: GitHub OAuth + repo selector */
        <div style={{ maxWidth: 500, width: "100%", padding: "2rem" }}>
          <h1 style={{ fontSize: 26, marginBottom: "1.5rem", letterSpacing: "-0.02em", textAlign: "center" }}>
            {current.title}
          </h1>
          {userId && (
            <GitHubRepoStep
              userId={userId}
              initialRepo={selectedRepo}
              onRepoSelected={(repo) => { void handleRepoSelected(repo); }}
            />
          )}
          <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: "1.75rem" }}>
            <button
              onClick={() => void handleNext()}
              disabled={saving || !step1Valid}
              style={{ opacity: saving || !step1Valid ? 0.5 : 1, cursor: saving || !step1Valid ? "not-allowed" : "pointer" }}
            >
              {saving ? "Saving…" : "Next →"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
