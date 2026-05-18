/** Post-activate "what's next?" CTA card.
 *
 *  After a customer finishes onboarding they land on Mission Control with
 *  KPIs + a fleet graph but no obvious next step. The fleet is live on
 *  mock-core (or whatever Paperclip backend the customer pointed at) and
 *  runs on a heartbeat schedule — but the customer doesn't know that.
 *
 *  This card surfaces:
 *    - The fleet is LIVE: heartbeat cadence
 *    - Where to watch the first cycle: Paperclip dashboard link
 *    - A "Force first cycle" affordance for customers who don't want to
 *      wait for the next heartbeat tick
 *
 *  Lightweight on purpose — no inference call, no per-frame polling. */

import { useEffect, useState } from "react";
import { useCompany } from "../../wavex-os/lib/CompanyContext";

interface HandoffState {
  paperclipUrl: string | null;
  paperclipCompanyId: string | null;
  handedOff: boolean;
  agentsTotal: number;
  agentsReady: number;
}

/** Paperclip is vendored at packages/core/ and runs on port 3100 by
 *  default (see packages/core/server/src/config.ts:294). We *used* to probe
 *  that port from the browser via no-cors, but Chrome logs
 *  `net::ERR_CONNECTION_REFUSED` to the DevTools console on every failed
 *  cross-origin fetch even when JS catches the rejection — flooding the
 *  console while we wait for Paperclip to boot.
 *
 *  Now we proxy through the wavex-os server: GET /api/paperclip-reachable
 *  returns { reachable: boolean } from a server-side fetch with no client
 *  console noise. Same logical behavior, zero DevTools spam. */
const PAPERCLIP_LOCAL_URL = "http://localhost:3100";

async function probePaperclipLocal(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const r = await fetch("/api/paperclip-reachable", { signal: controller.signal });
    clearTimeout(timer);
    if (!r.ok) return false;
    const j = (await r.json()) as { reachable?: boolean };
    return Boolean(j.reachable);
  } catch {
    return false;
  }
}

export function InceptionCTA() {
  const { companyId } = useCompany();
  const [state, setState] = useState<HandoffState | null>(null);
  const [localPaperclipReachable, setLocalPaperclipReachable] = useState<boolean | null>(null);
  const [forceBusy, setForceBusy] = useState(false);
  const [forceResult, setForceResult] = useState<string | null>(null);
  const [copyResult, setCopyResult] = useState<string | null>(null);

  useEffect(() => {
    if (!companyId) { setState(null); return; }
    let cancelled = false;
    void (async () => {
      // Best-effort probe — we ask /api/companies/<id>/agents to count
      // ready slots, and /api/instance/<id>/handoff for the paperclip URL.
      // Either failing is OK; the CTA degrades gracefully.
      let agentsTotal = 0;
      let agentsReady = 0;
      let paperclipUrl: string | null = null;
      let paperclipCompanyId: string | null = null;
      try {
        const r = await fetch(`/api/companies/${encodeURIComponent(companyId)}/agents`);
        if (r.ok) {
          const arr = (await r.json()) as Array<{ status: string }>;
          agentsTotal = arr.length;
          agentsReady = arr.filter((a) => a.status === "ready" || a.status === "active" || a.status === "idle").length;
        }
      } catch { /* mock-core may not expose this — ignore */ }
      try {
        const r = await fetch(`/api/instance/${encodeURIComponent(companyId)}/handoff`);
        if (r.ok) {
          const j = (await r.json()) as { ok: boolean; handoff?: HandoffState };
          if (j.handoff) {
            paperclipUrl = j.handoff.paperclipUrl;
            paperclipCompanyId = j.handoff.paperclipCompanyId;
          }
        }
      } catch { /* endpoint may not exist yet — ignore */ }
      if (cancelled) return;
      setState({
        paperclipUrl,
        paperclipCompanyId,
        handedOff: Boolean(paperclipUrl && paperclipCompanyId),
        agentsTotal,
        agentsReady,
      });
      // Only probe localhost when we DON'T already have a configured
      // handoff URL — otherwise we'd waste the round-trip.
      if (paperclipUrl) return;

      // First probe — if it's already up, set reachable and exit.
      const reachableNow = await probePaperclipLocal();
      if (cancelled) return;
      if (reachableNow) {
        setLocalPaperclipReachable(true);
        return;
      }

      // Not reachable yet. With `pnpm dev` now booting Paperclip by default
      // (see package.json), it's almost always coming up — give it a 60s
      // boot budget before falling back to the manual-copy UX. Poll every
      // 2s so the moment it's listening the user sees "Open Paperclip
      // Dashboard ↗" light up.
      setLocalPaperclipReachable(null); // explicit "waiting" state
      const MAX_WAIT_MS = 60_000;
      const POLL_INTERVAL_MS = 2_000;
      const startedAt = Date.now();
      while (!cancelled && Date.now() - startedAt < MAX_WAIT_MS) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        if (cancelled) return;
        const r = await probePaperclipLocal();
        if (cancelled) return;
        if (r) { setLocalPaperclipReachable(true); return; }
      }
      if (!cancelled) setLocalPaperclipReachable(false);
    })();
    return () => { cancelled = true; };
  }, [companyId]);

  if (!companyId || !state) return null;

  // Resolve the dashboard link only when we have a real, reachable target.
  // - configured handoff (paperclipUrl set) → trust it
  // - else if localhost:5174 probed reachable → use it
  // - else show no link (avoid the dead-localhost ERR_CONNECTION_REFUSED
  //   the operator hit the first time around).
  const paperclipLink: string | null = state.paperclipUrl && state.paperclipCompanyId
    ? `${state.paperclipUrl}/companies/${encodeURIComponent(state.paperclipCompanyId)}`
    : state.paperclipUrl
      ? state.paperclipUrl
      : localPaperclipReachable
        ? PAPERCLIP_LOCAL_URL
        : null;

  async function forceFirstCycle(): Promise<void> {
    if (!companyId) return;
    setForceBusy(true);
    setForceResult(null);
    try {
      const r = await fetch(`/api/companies/${encodeURIComponent(companyId)}/trigger-heartbeats`, {
        method: "POST",
      });
      if (r.ok) {
        const j = (await r.json()) as { ok: boolean; triggered?: number };
        setForceResult(`Triggered ${j.triggered ?? 0} heartbeats — refresh the fleet panel below to see new activity.`);
      } else {
        setForceResult(`Trigger endpoint returned HTTP ${r.status}. Fleet still runs on its normal cadence.`);
      }
    } catch (e) {
      setForceResult(`Couldn't reach trigger endpoint: ${(e as Error).message}. Fleet still runs on its normal cadence.`);
    } finally {
      setForceBusy(false);
    }
  }

  // Three render branches:
  //   1. paperclipLink set → primary CTA = "Open Paperclip Dashboard ↗"
  //   2. paperclipLink null + probe still resolving → show neutral status
  //   3. paperclipLink null + probe confirmed unreachable → show setup
  //      guidance (Paperclip GitHub link), NOT a broken localhost button.
  // This kills the ERR_CONNECTION_REFUSED the operator hit on the old
  // "default to localhost:5174 regardless" behavior.
  // States:
  //   probeStillResolving — first 1.5s before initial probe returns
  //   paperclipBooting    — Paperclip not up yet but `pnpm dev` should be
  //                          bringing it up; we're polling for ≤60s
  //   paperclipUnreachable — 60s elapsed and still not listening; fall
  //                          back to the copy-command UX
  // The two non-final states intentionally show identical UI ("Starting
  // Paperclip…"); the difference is only that the 60s timer is running
  // in probeStillResolving=false. localPaperclipReachable=null covers both.
  const probeStillResolving = paperclipLink === null && localPaperclipReachable === null && !state.paperclipUrl;
  const paperclipBooting = probeStillResolving;
  const paperclipUnreachable = paperclipLink === null && localPaperclipReachable === false;

  return (
    <div className="card" style={{
      marginBottom: "2.5rem",
      borderColor: "var(--accent)",
      background: "color-mix(in srgb, var(--accent) 6%, var(--surface))",
      padding: "1.1rem 1.25rem",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 11, color: "var(--accent)", fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 4 }}>
            Inception · your fleet is live
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
            {state.agentsReady > 0
              ? `${state.agentsReady} of ${state.agentsTotal} agents ready · first cycle starts on the next heartbeat tick`
              : "Your fleet is spawning · agents will start their first cycles within minutes"}
          </div>
          <div className="text-dim" style={{ fontSize: 12, lineHeight: 1.55 }}>
            {state.handedOff
              ? "Watch every issue, comment, and KPI snapshot live on the Paperclip dashboard."
              : paperclipUnreachable
                ? "Paperclip didn't come up within 60 s. If you're running `pnpm dev:no-paperclip`, switch to `pnpm dev` to boot it automatically."
                : paperclipBooting
                  ? "Starting Paperclip… the dashboard button will light up once it's listening (typically 5–20 s on first boot)."
                  : "Watch every issue, comment, and KPI snapshot on your local Paperclip dashboard."}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", alignItems: "stretch" }}>
          {paperclipLink && (
            <a
              href={paperclipLink}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                padding: "0.75rem 0.9rem",
                borderRadius: 6,
                background: "var(--accent)",
                color: "var(--bg)",
                fontWeight: 600,
                fontSize: 12,
                textDecoration: "none",
                textAlign: "center",
                display: "block",
                minHeight: 44,
              }}
            >
              Open Paperclip Dashboard ↗
            </a>
          )}
          {/* While Paperclip is booting under `pnpm dev`, show a disabled
              primary CTA that lights up the moment the dashboard responds.
              Users shouldn't have to know they should open another tab —
              the polling loop in useEffect handles the transition. */}
          {paperclipBooting && (
            <button
              type="button"
              disabled
              style={{
                padding: "0.75rem 0.9rem",
                borderRadius: 6,
                background: "color-mix(in srgb, var(--accent) 35%, var(--surface))",
                color: "var(--bg)",
                fontWeight: 600,
                fontSize: 12,
                border: "none",
                cursor: "wait",
                textAlign: "center",
                opacity: 0.85,
              }}
              title="Paperclip is being started by `pnpm dev`. This button will activate once the dashboard is listening on localhost:3100."
            >
              Starting Paperclip…
            </button>
          )}
          {/* Only after the 60s grace period do we offer the manual command
              copy as a last resort — at that point the user is almost
              certainly on `pnpm dev:no-paperclip` and needs the nudge. */}
          {paperclipUnreachable && (
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText("pnpm run dev:paperclip");
                  setCopyResult("Copied · paste it in a new terminal in this repo");
                  setTimeout(() => setCopyResult(null), 4000);
                } catch {
                  setCopyResult("Couldn't copy — select and copy the command below");
                  setTimeout(() => setCopyResult(null), 4000);
                }
              }}
              style={{
                padding: "0.75rem 0.9rem",
                borderRadius: 6,
                background: "var(--accent)",
                color: "var(--bg)",
                fontWeight: 600,
                fontSize: 12,
                border: "none",
                cursor: "pointer",
                textAlign: "center",
              }}
            >
              Copy start command
            </button>
          )}
          <button
            type="button"
            onClick={() => void forceFirstCycle()}
            disabled={forceBusy}
            style={{
              padding: "0.75rem 0.9rem",
              borderRadius: 6,
              background: "transparent",
              border: "1px solid var(--border)",
              color: "var(--text-dim)",
              fontSize: 11,
              cursor: forceBusy ? "not-allowed" : "pointer",
            }}
            title="Forces every agent in the fleet to run one heartbeat immediately instead of waiting for the next scheduled tick."
          >
            {forceBusy ? "Triggering…" : "Force first cycle now"}
          </button>
        </div>
      </div>
      {paperclipUnreachable && (
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: "0.6rem", paddingTop: "0.5rem", borderTop: "1px solid var(--border)", lineHeight: 1.6 }}>
          `pnpm dev` now boots Paperclip automatically, but we didn't see it
          come up within 60 s. If you're running a subset (e.g.{" "}
          <code style={{ padding: "0.05rem 0.35rem", background: "var(--surface-2)", borderRadius: 3 }}>pnpm dev:no-paperclip</code>
          {" "}or just{" "}
          <code style={{ padding: "0.05rem 0.35rem", background: "var(--surface-2)", borderRadius: 3 }}>pnpm dev:ui</code>
          ), open a second terminal in this repo and run{" "}
          <code style={{ padding: "0.05rem 0.35rem", background: "var(--surface-2)", borderRadius: 3 }}>pnpm run dev:paperclip</code>
          {" "}— that boots the vendored Paperclip core at <code>localhost:3100</code> with your <strong>{companyId}</strong> fleet already incepted.
        </div>
      )}
      {copyResult && (
        <div style={{ fontSize: 11, color: "var(--accent)", marginTop: "0.4rem" }}>
          ✓ {copyResult}
        </div>
      )}
      {forceResult && (
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: "0.6rem", paddingTop: "0.5rem", borderTop: "1px solid var(--border)" }}>
          {forceResult}
        </div>
      )}
    </div>
  );
}
