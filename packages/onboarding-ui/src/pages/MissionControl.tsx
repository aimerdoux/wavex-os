import { useEffect, useMemo, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { HealthStrip } from "../components/mission/HealthStrip";
import { InceptionCTA } from "../components/mission/InceptionCTA";
import { KpiBoard } from "../components/mission/KpiBoard";
import { FleetGraph } from "../components/mission/FleetGraph";
import { PrivacyPanel } from "../components/PrivacyPanel";
import { AllocationSlider } from "../components/AllocationSlider";
import { OnboardingChecklist } from "../components/mission/OnboardingChecklist";
import { WizardMetricsPanel } from "../components/mission/WizardMetricsPanel";
import { useCompany } from "../wavex-os/lib/CompanyContext";
import { getSupabase } from "../lib/supabase";
import { CoachmarkOverlay, type CoachmarkStep } from "../wavex-os/components/Coachmark";
import { useCoachmark } from "../wavex-os/lib/coachmarks";

interface CompaniesPayload { ok: boolean; companies: Array<{ id: string; name: string }>; }

function CompanyPicker() {
  const { companyId, setCompanyId } = useCompany();
  const q = useQuery<CompaniesPayload>({
    queryKey: ["companies"],
    queryFn: async () => {
      const r = await fetch("/api/companies");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 60_000,
  });
  const companies = q.data?.companies ?? [];

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span className="text-dim" style={{ fontSize: 12 }}>Company:</span>
      <select
        value={companyId ?? ""}
        onChange={(e) => setCompanyId(e.target.value || null)}
        style={{ fontSize: 13, padding: "4px 8px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 4 }}
      >
        <option value="">— select —</option>
        {companies.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      <Link to="/onboarding-chat" style={{ fontSize: 12, padding: "8px", display: "inline-flex", alignItems: "center", minHeight: 44, minWidth: 44 }}>+ New</Link>
    </div>
  );
}

export default function MissionControl() {
  const { companyId } = useCompany();
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // Fresh-install redirect: when the customer has zero companies AND none
  // selected, the canonical landing is the chat-first onboarding gateway
  // (Avatar / Solo Founder / Hybrid), not Mission Control's empty state.
  // Once they finish onboarding their first company, this naturally stops
  // firing (companies.length > 0). Probing companies via the same query the
  // CompanyPicker uses keeps cache-coherence; we wait for the result before
  // deciding (the !isFetching gate avoids a flash of redirect-then-not).
  const companiesQ = useQuery<CompaniesPayload>({
    queryKey: ["companies"],
    queryFn: async () => {
      const r = await fetch("/api/companies");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
  });
  const hasZeroCompanies = companiesQ.isSuccess && (companiesQ.data?.companies ?? []).length === 0;
  if (!companyId && hasZeroCompanies) {
    return <Navigate to="/onboarding-chat" replace />;
  }

  // Phase 7-B — first-run walkthrough for Mission Control.
  const tour = useCoachmark("coachmark-mission-v1");
  const tourSteps: CoachmarkStep[] = useMemo(() => [
    {
      target: () => document.querySelector<HTMLElement>("[data-tour='mc-health']"),
      title: "Live status, at a glance",
      body: "Green here means everything's running. If something turns yellow or red, you'll see it here first.",
    },
    {
      target: () => document.querySelector<HTMLElement>("[data-tour='mc-kpis']"),
      title: "Your headline goal",
      body: "This is the number your team is moving — and the supporting metrics underneath. Updates as the agents work.",
    },
    {
      target: () => document.querySelector<HTMLElement>("[data-tour='mc-fleet']"),
      title: "Every agent in your org",
      body: "Each card is one agent. Status updates live as they spawn, pause, or finish a run.",
    },
    {
      target: () => document.querySelector<HTMLElement>("[data-tour='mc-privacy']"),
      title: "Who can see your data",
      body: "Every external agent reading your data shows up here, with a one-click revoke if you change your mind.",
    },
    {
      target: () => document.querySelector<HTMLElement>("[data-tour='mc-company']"),
      title: "Switch or start over",
      body: "Pick a different company here, or click '+ New' to start a fresh onboarding from scratch.",
    },
  ], []);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <header style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "1rem 2rem",
        borderBottom: "1px solid var(--border)",
        background: "var(--surface)",
        position: "sticky",
        top: 0,
        zIndex: 10,
      }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem" }}>
          <span style={{ fontWeight: 700, fontSize: 16, letterSpacing: "-0.01em" }}>WaveX OS</span>
          <span className="text-dim" style={{ fontSize: 12 }}>· Mission Control</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "1.25rem" }}>
          <div data-tour="mc-company"><CompanyPicker /></div>
          <div data-tour="mc-health"><HealthStrip /></div>
        </div>
      </header>

      <main style={{ maxWidth: 1200, margin: "0 auto", padding: "2rem" }}>
        {!companyId && (
          <div className="card" style={{
            borderColor: "var(--accent)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "1rem",
            marginBottom: "2rem",
          }}>
            <div>
              <strong>No company selected.</strong>{" "}
              <span className="text-dim">Pick one from the dropdown or start onboarding for a new one.</span>
            </div>
            <Link to="/onboarding-chat">
              <button>Start onboarding →</button>
            </Link>
          </div>
        )}

        <div style={{ display: "flex", gap: "2rem", alignItems: "flex-start" }}>
          {/* ── main content column ── */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Inception CTA — when a company is selected, surface the "your
                fleet is live, here's what to do next" card BEFORE the KPIs so
                the customer has an obvious path forward. The legacy mission
                control was a dead-end after activate. */}
            {companyId && <InceptionCTA />}

            <div data-tour="mc-kpis" style={{ marginBottom: "2.5rem" }}>
              <KpiBoard />
            </div>

            <WizardMetricsPanel />

            <div data-tour="mc-fleet" style={{ marginBottom: "2.5rem" }}>
              <FleetGraph />
            </div>

            {/* Live-adjustable Claude Max allocation — operator tunes the
                swarm-vs-Pool-A split as they watch consumption. Changes apply
                to the next fleet cycle (heartbeat intervals re-scale at the
                next hire / re-ignition). */}
            <div data-tour="mc-allocation" style={{ marginBottom: "2.5rem" }}>
              <AllocationSlider variant="console" />
            </div>

            <div data-tour="mc-privacy" style={{ marginBottom: "2.5rem" }}>
              <PrivacyPanel session={session} />
            </div>

            <div className="card">
              <h3 style={{ marginTop: 0, fontSize: 14, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Coming next
              </h3>
              <ul style={{ margin: 0, paddingLeft: "1.25rem", color: "var(--text-dim)", lineHeight: 1.8, fontSize: 13 }}>
                <li>Workflows queue (issues by status, filterable)</li>
                <li>Approvals tray (board approvals routed via Telegram + UI)</li>
                <li>Workspace tray (ngrok status, Composio health, etc.)</li>
                <li>Real Paperclip core in place of mock-core</li>
                <li>System Optimizer daily injections</li>
              </ul>
            </div>

            <p className="text-dim" style={{ fontSize: 11, marginTop: "2rem", textAlign: "center" }}>
              WaveX OS · MIT · <a href="https://github.com/aimerdoux/wavex-os" target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", minHeight: 44 }}>github.com/aimerdoux/wavex-os</a>
            </p>
          </div>

          {/* ── sidebar: onboarding checklist (design partners) ── */}
          {companyId && (
            <aside style={{ width: 240, flexShrink: 0, position: "sticky", top: "5rem" }}>
              <OnboardingChecklist />
            </aside>
          )}
        </div>
      </main>
      {!tour.dismissed && (
        <CoachmarkOverlay steps={tourSteps} onDone={tour.dismiss} />
      )}
    </div>
  );
}
