/** Monte Carlo race — animated 5-strategy line chart for the Imprint Theater
 *  Act 1.
 *
 *  The MC report ships summary stats per strategy (mean_mrr_growth, p_ruin,
 *  sharpe, mean_burn_multiple) but no per-cycle samples. We synthesize a
 *  representational curve per strategy by interpolating from a shared start
 *  to each strategy's mean_mrr_growth as the end-value, using an ease-out
 *  shape that looks like a compounding growth trajectory. The winner curve
 *  highlights with full opacity at the end of the animation. */

import { useEffect, useState } from "react";
import { wavexOsOnboardingApi } from "../lib/api";

/** Local shape of MonteCarloReport — plugin-onboarding's barrel doesn't
 *  re-export the type, so we narrow to the fields the chart consumes.
 *  Stays compatible with the wire shape returned by GET /wavex-os/onboarding/mc-report. */
export interface StrategyRow {
  strategy_id: string;
  mean_mrr_growth: number;
  /** Pre-scale runs hold MRR flat by design — activation growth is the
   *  stat that actually differentiates strategies there. */
  mean_activation_growth?: number;
  p_ruin: number;
  sharpe: number;
}

/** Pre-scale mode produces mean_mrr_growth=0 for EVERY strategy by design,
 *  which used to flatline all five race curves at zero ("no numbers, no
 *  graphics" — operator QA 2026-06-10). When MRR growth is degenerate,
 *  race on activation growth instead. */
export function isMrrDegenerate(rows: StrategyRow[]): boolean {
  return rows.length > 0 && rows.every((s) => Math.abs(s.mean_mrr_growth) < 1e-9);
}

export function raceValue(s: StrategyRow, mrrDegenerate: boolean): number {
  if (mrrDegenerate) return Math.max(0, s.mean_activation_growth ?? 0);
  return Math.max(0, s.mean_mrr_growth);
}

export interface MonteCarloReportLike {
  horizon_cycles: number;
  n_runs_per_strategy: number;
  strategies: StrategyRow[];
  winner: { strategy_id: string; rationale: string };
}

const STRATEGY_COLORS: Record<string, string> = {
  RETENTION_FIRST: "#86c5da",
  BALANCED: "#4ec9b0",
  ACQUISITION_HEAVY: "#f0b070",
  NARRATIVE_LED: "#c590e0",
  CAPITAL_EFFICIENT: "#9aa0a6",
};

const STRATEGY_LABELS: Record<string, string> = {
  RETENTION_FIRST: "Retention first",
  BALANCED: "Balanced",
  ACQUISITION_HEAVY: "Acquisition heavy",
  NARRATIVE_LED: "Narrative led",
  CAPITAL_EFFICIENT: "Capital efficient",
};

interface Props {
  report: MonteCarloReportLike;
  /** Wavex-os company ID. When provided, the component fetches a BYOC
   *  narration of the report from /wavex-os/onboarding/mc-narrate in
   *  parallel with the race animation and renders it below the legend
   *  once it arrives. Omitting falls back to no narration (the
   *  static legend alone). */
  companyId?: string;
  durationMs?: number;
  onComplete?: () => void;
}

interface NarrativeState {
  status: "loading" | "ready" | "skipped";
  text: string | null;
  /** Provenance chip: distinguishes a real BYOC claude reading from a
   *  deterministic fallback so the customer doesn't get a misleading
   *  "AI explanation" badge when claude was unreachable. */
  attribution: "byoc-claude" | "fallback-deterministic" | null;
}

const WIDTH = 720;
const HEIGHT = 280;
const PAD_X = 60;
const PAD_Y = 30;

export function MonteCarloRace({ report, companyId, durationMs = 6000, onComplete }: Props) {
  const [progress, setProgress] = useState(0);
  const [narrative, setNarrative] = useState<NarrativeState>({
    status: companyId ? "loading" : "skipped",
    text: null,
    attribution: null,
  });

  useEffect(() => {
    const startedAt = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const elapsed = now - startedAt;
      const next = Math.min(1, elapsed / durationMs);
      setProgress(next);
      if (next < 1) raf = requestAnimationFrame(tick);
      else onComplete?.();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [durationMs, onComplete]);

  // BYOC narration. Fire on mount in parallel with the animation. Claude
  // typically returns in ~10-20s vs. the 6s animation, so the customer
  // sees the race finish, then the narrative slides in. Failure is
  // silent — we just leave the legend without the extra paragraphs.
  useEffect(() => {
    if (!companyId) {
      setNarrative({ status: "skipped", text: null, attribution: null });
      return;
    }
    let cancelled = false;
    setNarrative({ status: "loading", text: null, attribution: null });
    wavexOsOnboardingApi
      .mcNarrate({ companyId })
      .then((res) => {
        if (cancelled) return;
        if (res.ok && res.narrative) {
          setNarrative({
            status: "ready",
            text: res.narrative,
            attribution: res.model_attribution ?? null,
          });
        } else {
          setNarrative({ status: "skipped", text: null, attribution: null });
        }
      })
      .catch(() => {
        if (cancelled) return;
        setNarrative({ status: "skipped", text: null, attribution: null });
      });
    return () => { cancelled = true; };
  }, [companyId]);

  // Normalize end-values across strategies into a 0..1 range for the chart's
  // y-axis. In pre-scale runs every mean_mrr_growth is 0 by design, so the
  // race switches to activation growth (see raceValue).
  const mrrDegenerate = isMrrDegenerate(report.strategies);
  const maxGrowth = Math.max(
    ...report.strategies.map((s: StrategyRow) => raceValue(s, mrrDegenerate)),
    0.05,
  );

  const winnerId = report.winner.strategy_id;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.5rem" }}>
      {/* Header caption — operator-readable framing for what the race
       *  actually represents. Without this the curves are engineering candy
       *  that looks impressive but mysterious. */}
      <div style={{ textAlign: "center", maxWidth: 560 }}>
        <div style={{ fontSize: 13, color: "var(--text)", fontWeight: 600, marginBottom: "0.25rem" }}>
          Finding your winning growth strategy
        </div>
        <div className="text-dim" style={{ fontSize: 11, lineHeight: 1.5 }}>
          {report.n_runs_per_strategy} runs × {report.horizon_cycles} cycles across 5 GTM
          strategies —{" "}
          {mrrDegenerate
            ? "pre-scale model: MRR is held flat by design, so the race is projected activation lift."
            : "the one with the best compound MRR trajectory wins."}
        </div>
      </div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width="100%" style={{ maxWidth: WIDTH }}>
        {/* y-axis grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((p) => (
          <line
            key={p}
            x1={PAD_X}
            x2={WIDTH - 20}
            y1={PAD_Y + (HEIGHT - PAD_Y * 2) * (1 - p)}
            y2={PAD_Y + (HEIGHT - PAD_Y * 2) * (1 - p)}
            stroke="var(--border)"
            strokeWidth={0.5}
            opacity={0.4}
          />
        ))}
        {/* x-axis label */}
        <text x={PAD_X} y={HEIGHT - 6} fontSize={10} fill="var(--text-dim)">cycle 0</text>
        <text x={WIDTH - 60} y={HEIGHT - 6} fontSize={10} fill="var(--text-dim)">cycle {report.horizon_cycles}</text>
        {/* strategy curves */}
        {report.strategies.map((s: StrategyRow) => (
          <StrategyLine
            key={s.strategy_id}
            strategy={s}
            progress={progress}
            maxGrowth={maxGrowth}
            mrrDegenerate={mrrDegenerate}
            isWinner={s.strategy_id === winnerId}
          />
        ))}
      </svg>
      <div style={{ display: "flex", gap: "0.85rem", flexWrap: "wrap", justifyContent: "center", marginTop: "0.25rem" }}>
        {report.strategies.map((s: StrategyRow) => (
          <div
            key={s.strategy_id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.35rem",
              fontSize: 11,
              opacity: progress > 0.85 && s.strategy_id !== winnerId ? 0.35 : 1,
              transition: "opacity 0.6s ease-out",
            }}
          >
            <span style={{ width: 10, height: 2, background: STRATEGY_COLORS[s.strategy_id] ?? "#888", borderRadius: 2 }} />
            <span style={{ color: s.strategy_id === winnerId && progress > 0.85 ? "var(--accent)" : "var(--text-dim)", fontWeight: s.strategy_id === winnerId && progress > 0.85 ? 700 : 400 }}>
              {STRATEGY_LABELS[s.strategy_id] ?? s.strategy_id}
            </span>
          </div>
        ))}
      </div>
      <NarrativeBlock narrative={narrative} raceDone={progress >= 1} />
    </div>
  );
}

/** Renders the BYOC narration below the race. Only shows once the race
 *  animation has completed (progress >= 1) so the narrative doesn't
 *  steal attention while the chart is still drawing. Stays out of the
 *  way (just dim text) when narration is skipped or claude failed. */
function NarrativeBlock({ narrative, raceDone }: { narrative: NarrativeState; raceDone: boolean }) {
  if (!raceDone) return null;
  if (narrative.status === "skipped") return null;
  if (narrative.status === "loading") {
    return (
      <div className="text-dim" style={{ fontSize: 11, marginTop: "0.5rem", textAlign: "center", fontStyle: "italic" }}>
        Reading the simulation…
      </div>
    );
  }
  // ready
  const badge = narrative.attribution === "byoc-claude"
    ? { text: "Read by your Claude", bg: "rgba(78,201,176,0.16)", fg: "#4ec9b0" }
    : { text: "Deterministic reading", bg: "rgba(154,160,166,0.18)", fg: "#9aa0a6" };
  return (
    <div
      style={{
        marginTop: "0.85rem",
        maxWidth: 620,
        padding: "0.75rem 0.95rem",
        background: "var(--surface-soft, rgba(255,255,255,0.03))",
        border: "1px solid var(--border)",
        borderRadius: 8,
        fontSize: 12,
        lineHeight: 1.6,
        color: "var(--text)",
        whiteSpace: "pre-wrap",
      }}
    >
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "0.35rem" }}>
        <span
          style={{
            fontSize: 10,
            padding: "0.1rem 0.45rem",
            borderRadius: 999,
            background: badge.bg,
            color: badge.fg,
            fontWeight: 600,
            letterSpacing: 0.2,
          }}
        >
          {badge.text}
        </span>
      </div>
      {narrative.text}
    </div>
  );
}

function StrategyLine({
  strategy, progress, maxGrowth, mrrDegenerate, isWinner,
}: {
  strategy: StrategyRow;
  progress: number;
  maxGrowth: number;
  mrrDegenerate: boolean;
  isWinner: boolean;
}) {
  const color = STRATEGY_COLORS[strategy.strategy_id] ?? "#888";
  // Build a synthetic curve from the strategy's race value (MRR growth, or
  // activation growth when MRR is design-frozen pre-scale). The winner
  // gets a 30% visual boost so it reaches near the top of the chart and
  // clearly "wins" the race rather than tying with the runners-up.
  const baseEnd = Math.max(0, Math.min(1, raceValue(strategy, mrrDegenerate) / maxGrowth));
  const normalizedEnd = isWinner ? Math.min(0.92, baseEnd * 1.3 + 0.1) : baseEnd * 0.85;
  const N = 30;
  const visibleSamples = Math.max(2, Math.floor(progress * N));
  const points: Array<[number, number]> = [];
  for (let i = 0; i < visibleSamples; i++) {
    const t = i / (N - 1);
    // Winner uses a steeper ease-out (quart) so the line accelerates upward.
    // Others use the gentler cubic.
    const ease = isWinner ? 1 - Math.pow(1 - t, 4) : 1 - Math.pow(1 - t, 3);
    const y = ease * normalizedEnd;
    const px = PAD_X + ((WIDTH - PAD_X - 20) * t);
    const py = PAD_Y + (HEIGHT - PAD_Y * 2) * (1 - y);
    points.push([px, py]);
  }
  const polyPoints = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

  // Winner gets an area-fill underneath for emphasis once the race winds down.
  const showFill = isWinner && progress > 0.5 && points.length > 1;
  const fillOpacity = isWinner ? Math.max(0, (progress - 0.5) * 0.5) : 0;
  const baselineY = HEIGHT - PAD_Y;
  const areaPath = showFill
    ? `M ${points[0][0]},${baselineY} ${polyPoints} L ${points[points.length - 1][0]},${baselineY} Z`
    : "";

  // Marker dot at the leading edge of the line for the winner.
  const lead = points[points.length - 1];

  const opacity = isWinner ? (progress > 0.85 ? 1 : 0.95) : (progress > 0.85 ? 0.2 : 0.7);
  const strokeWidth = isWinner ? (progress > 0.85 ? 4 : 3) : 1.5;

  return (
    <g style={{ transition: "opacity 0.5s ease-out" }} opacity={opacity}>
      {showFill && (
        <path d={areaPath} fill={color} opacity={fillOpacity} />
      )}
      <polyline
        points={polyPoints}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ transition: "stroke-width 0.5s ease-out" }}
      />
      {isWinner && lead && progress > 0.05 && (
        <circle
          cx={lead[0]}
          cy={lead[1]}
          r={progress > 0.85 ? 5 : 3.5}
          fill={color}
          stroke="var(--bg)"
          strokeWidth={1.5}
          style={{ transition: "r 0.4s ease-out" }}
        />
      )}
    </g>
  );
}
