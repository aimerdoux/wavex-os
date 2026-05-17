/**
 * WaveX plugin UI bundles.
 *
 * Three slot components mounted into Paperclip's dashboard / sidebar /
 * settings page. All read-only — the user takes any action via Paperclip's
 * native commands or by jumping to the wavex-os Mission Control. This
 * keeps the plugin from getting out of sync with the host's authority
 * model (issues are still the source of truth for state changes).
 */
import { usePluginData } from "@wavex-os/plugin-sdk-shim/ui";
import type {
  PluginWidgetProps,
  PluginSidebarProps,
  PluginSettingsPageProps,
} from "@wavex-os/plugin-sdk-shim/ui";

// Mission Control — Phase 1 Stream widget (plain-language activity feed).
export { MissionControlStreamWidget } from "./MissionControlStreamWidget.js";
// Mission Control — Phase 2 Deliverables table + inspector drawer.
export { MissionControlDeliverablesWidget } from "./MissionControlDeliverablesWidget.js";
// Mission Control — Phase 3 KPI Scoreboard.
export { MissionControlScoreboardWidget } from "./MissionControlScoreboardWidget.js";
// Mission Control — Phase 4 Node profile + assignment chain inspector.
export { MissionControlNodeProfileWidget } from "./MissionControlNodeProfileWidget.js";
// Mission Control — Phase 5 Accountability Graph (SVG force layout).
export { MissionControlGraphWidget } from "./MissionControlGraphWidget.js";
// Mission Control — Phase 6 Chief of Staff config + rules + evaluator.
export { MissionControlChiefWidget } from "./MissionControlChiefWidget.js";
// Mission Control — Phase 7 polish (cost / capacity / weekly export).
export { MissionControlPolishWidget } from "./MissionControlPolishWidget.js";

const WAVEX_COLOR = "#00d4ff";
const WAVEX_BG = "color-mix(in srgb, #00d4ff 6%, transparent)";

// ---------------------------------------------------------------------------
// Dashboard widget — Expert Agents catalog + active hires per agent
// ---------------------------------------------------------------------------

interface ExpertAgentsResponse {
  agents: Array<{ id: string; displayName: string; activeHires: number }>;
  source: string;
}

export function ExpertAgentsStatusWidget(_: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<ExpertAgentsResponse>(
    "expert-agents-list",
    {},
  );

  if (loading) return <SkeletonCard label="WaveX Expert Agents" />;
  if (error) {
    return (
      <Card label="WaveX Expert Agents">
        <div style={{ color: "#ff6b6b" }}>
          Couldn't reach WaveX: {error.message}
        </div>
      </Card>
    );
  }
  if (!data || data.agents.length === 0) {
    return (
      <Card label="WaveX Expert Agents">
        <div style={{ opacity: 0.7 }}>
          {data?.source === "no-supabase-config"
            ? "Configure Supabase URL + publishable key in WaveX Preferences to enable this widget."
            : "No Expert Agents in catalog yet."}
        </div>
      </Card>
    );
  }

  return (
    <Card label="WaveX Expert Agents">
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <tbody>
          {data.agents.map((a) => (
            <tr key={a.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
              <td style={{ padding: "6px 0", fontWeight: 500 }}>{a.displayName}</td>
              <td style={{ padding: "6px 0", textAlign: "right", opacity: 0.7 }}>
                {a.activeHires} active hire{a.activeHires === 1 ? "" : "s"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Dashboard widget — recent deliverables: accountability + token cost
// ---------------------------------------------------------------------------

interface Deliverable {
  id: string;
  assignedAgent: string | null;
  planRef: string | null;
  expectedResponse: string | null;
  kind: string;
  status: string;
  issueId: string | null;
  totalTokens: number;
}

interface DeliverablesResponse {
  deliverables: Deliverable[];
  source: string;
}

const STATUS_TINT: Record<string, string> = {
  open: "#8a8f98",
  in_progress: "#00d4ff",
  delivered: "#ffd166",
  verified: "#4ade80",
  failed: "#ff6b6b",
};

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function StatusPill({ status }: { status: string }) {
  const tint = STATUS_TINT[status] ?? "#8a8f98";
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.03em",
        textTransform: "uppercase",
        padding: "2px 6px",
        borderRadius: 4,
        color: tint,
        border: `1px solid color-mix(in srgb, ${tint} 40%, transparent)`,
        background: `color-mix(in srgb, ${tint} 12%, transparent)`,
        whiteSpace: "nowrap",
      }}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function DeliverablesWidget(_: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<DeliverablesResponse>(
    "deliverables-list",
    {},
  );

  if (loading) return <SkeletonCard label="WaveX Deliverables" />;
  if (error) {
    return (
      <Card label="WaveX Deliverables">
        <div style={{ color: "#ff6b6b" }}>
          Couldn't reach WaveX: {error.message}
        </div>
      </Card>
    );
  }
  if (!data || data.deliverables.length === 0) {
    return (
      <Card label="WaveX Deliverables">
        <div style={{ opacity: 0.7 }}>
          {data?.source === "no-supabase-config"
            ? "Configure Supabase URL + publishable key in WaveX Preferences to enable this widget."
            : "No deliverables recorded yet."}
        </div>
      </Card>
    );
  }

  return (
    <Card label="WaveX Deliverables">
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <tbody>
          {data.deliverables.map((d) => (
            <tr key={d.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
              <td style={{ padding: "8px 0", verticalAlign: "top" }}>
                <div style={{ fontWeight: 500 }}>
                  {d.assignedAgent ?? "unassigned"}
                </div>
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>
                  {truncate(d.planRef ?? "—", 24)}{" "}
                  <span style={{ opacity: 0.5 }}>→</span>{" "}
                  {truncate(d.expectedResponse ?? "—", 48)}
                </div>
              </td>
              <td
                style={{
                  padding: "8px 0 8px 8px",
                  textAlign: "right",
                  verticalAlign: "top",
                  whiteSpace: "nowrap",
                }}
              >
                <StatusPill status={d.status} />
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                  {formatTokens(d.totalTokens)} tok
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Mission Control — Fleet KPIs: goal progress as progress gauges
// ---------------------------------------------------------------------------

interface CompanyGoal {
  id: string;
  label: string;
  metric: string;
  current: number;
  target: number;
  unit: string;
  status: string;
}

interface CompanyGoalsResponse {
  goals: CompanyGoal[];
  source: string;
}

function formatNum(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function FleetKpisWidget(_: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<CompanyGoalsResponse>(
    "company-goals",
    {},
  );

  if (loading) return <SkeletonCard label="WaveX Fleet KPIs" />;
  if (error) {
    return (
      <Card label="WaveX Fleet KPIs">
        <div style={{ color: "#ff6b6b" }}>Couldn't reach WaveX: {error.message}</div>
      </Card>
    );
  }
  if (!data || data.goals.length === 0) {
    return (
      <Card label="WaveX Fleet KPIs">
        <div style={{ opacity: 0.7 }}>
          {data?.source === "no-supabase-config"
            ? "Configure Supabase URL + publishable key in WaveX Preferences to enable this widget."
            : "No company goals defined yet. Goals appear once a company manifest is provisioned."}
        </div>
      </Card>
    );
  }

  return (
    <Card label="WaveX Fleet KPIs">
      <div style={{ display: "grid", gap: 14 }}>
        {data.goals.map((g) => (
          <ProgressGauge
            key={g.id}
            label={g.label}
            current={g.current}
            target={g.target}
            unit={g.unit}
          />
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Mission Control — Deliverables throughput: count by status + token cost
// ---------------------------------------------------------------------------

interface ThroughputResponse {
  byStatus: Record<string, number>;
  totalTokens: number;
  total: number;
  source: string;
}

// Stable status ordering for the bar chart (matches the deliverable lifecycle).
const STATUS_ORDER = ["open", "in_progress", "delivered", "verified", "failed"];

export function DeliverablesThroughputWidget(_: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<ThroughputResponse>(
    "deliverable-throughput",
    {},
  );

  if (loading) return <SkeletonCard label="WaveX Deliverables Throughput" />;
  if (error) {
    return (
      <Card label="WaveX Deliverables Throughput">
        <div style={{ color: "#ff6b6b" }}>Couldn't reach WaveX: {error.message}</div>
      </Card>
    );
  }
  if (!data || data.total === 0) {
    return (
      <Card label="WaveX Deliverables Throughput">
        <div style={{ opacity: 0.7 }}>
          {data?.source === "no-supabase-config"
            ? "Configure Supabase URL + publishable key in WaveX Preferences to enable this widget."
            : "No deliverables recorded yet."}
        </div>
      </Card>
    );
  }

  const max = Math.max(1, ...Object.values(data.byStatus));
  const rows = STATUS_ORDER.filter((s) => (data.byStatus[s] ?? 0) > 0).concat(
    // Include any unexpected status values the RPC may surface.
    Object.keys(data.byStatus).filter((s) => !STATUS_ORDER.includes(s)),
  );

  return (
    <Card label="WaveX Deliverables Throughput">
      <div style={{ display: "grid", gap: 8 }}>
        {rows.map((status) => (
          <Bar
            key={status}
            label={status.replace(/_/g, " ")}
            value={data.byStatus[status] ?? 0}
            max={max}
            color={STATUS_TINT[status] ?? "#8a8f98"}
          />
        ))}
      </div>
      <div
        style={{
          marginTop: 12,
          paddingTop: 10,
          borderTop: "1px solid rgba(255,255,255,0.08)",
          display: "flex",
          justifyContent: "space-between",
          fontSize: 13,
        }}
      >
        <span style={{ opacity: 0.7 }}>
          {data.total} deliverable{data.total === 1 ? "" : "s"}
        </span>
        <span style={{ fontWeight: 600, color: WAVEX_COLOR }}>
          {formatTokens(data.totalTokens)} tok total
        </span>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Mission Control — Agent status: running / idle / error as a compact donut
// ---------------------------------------------------------------------------

interface AgentStatusResponse {
  running: number;
  idle: number;
  error: number;
  devices: number;
  source: string;
}

export function AgentStatusWidget(_: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<AgentStatusResponse>(
    "fleet-agent-status",
    {},
  );

  if (loading) return <SkeletonCard label="WaveX Agent Status" />;
  if (error) {
    return (
      <Card label="WaveX Agent Status">
        <div style={{ color: "#ff6b6b" }}>Couldn't reach WaveX: {error.message}</div>
      </Card>
    );
  }
  const total = data ? data.running + data.idle + data.error : 0;
  if (!data || total === 0) {
    return (
      <Card label="WaveX Agent Status">
        <div style={{ opacity: 0.7 }}>
          {data?.source === "no-supabase-config"
            ? "Configure Supabase URL + publishable key in WaveX Preferences to enable this widget."
            : "No fleet agents reporting yet."}
        </div>
      </Card>
    );
  }

  const segments = [
    { label: "running", value: data.running, color: "#4ade80" },
    { label: "idle", value: data.idle, color: "#8a8f98" },
    { label: "error", value: data.error, color: "#ff6b6b" },
  ];

  return (
    <Card label="WaveX Agent Status">
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <DonutMini segments={segments} total={total} centerLabel="agents" />
        <div style={{ display: "grid", gap: 6, flex: 1 }}>
          {segments.map((s) => (
            <div
              key={s.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 13,
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: s.color,
                  flexShrink: 0,
                }}
              />
              <span style={{ opacity: 0.7, textTransform: "capitalize" }}>
                {s.label}
              </span>
              <span style={{ marginLeft: "auto", fontWeight: 600 }}>{s.value}</span>
            </div>
          ))}
          <div style={{ fontSize: 11, opacity: 0.5, marginTop: 2 }}>
            across {data.devices} device{data.devices === 1 ? "" : "s"}
          </div>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Sidebar — current company's inception status
// ---------------------------------------------------------------------------

interface InceptionStatusResponse {
  agentsTotal: number;
  agentsReady: number;
  source: string;
}

export function InceptionStatusPanel({ context }: PluginSidebarProps) {
  const { data, loading } = usePluginData<InceptionStatusResponse>(
    "inception-status",
    { companyId: context.companyId },
  );

  return (
    <Card label="Inception Status">
      {loading ? (
        <div style={{ opacity: 0.6 }}>Checking fleet readiness…</div>
      ) : data ? (
        <>
          <div style={{ fontSize: 22, fontWeight: 600, color: WAVEX_COLOR }}>
            {data.agentsReady}
            <span style={{ fontSize: 14, opacity: 0.6 }}> / {data.agentsTotal} ready</span>
          </div>
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
            {data.agentsTotal === 0
              ? "Fleet not yet incepted. Finalize onboarding in WaveX Mission Control."
              : data.agentsReady === data.agentsTotal
                ? "Fleet is fully live. First cycle starts at next heartbeat tick."
                : `${data.agentsTotal - data.agentsReady} agents still spawning.`}
          </div>
        </>
      ) : (
        <div style={{ opacity: 0.6 }}>No fleet data for this company.</div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Settings page — subscription overview + Supabase config hint
// ---------------------------------------------------------------------------

interface SubInfoResponse {
  configured: boolean;
  expertAgentsHired?: number;
  lastStripeWebhookAt?: string | null;
  lastStripeWebhookType?: string | null;
  error?: string;
}

export function WaveXSettingsPage(_: PluginSettingsPageProps) {
  const { data, loading } = usePluginData<SubInfoResponse>("subscription-info", {});

  return (
    <div style={{ padding: 16, display: "grid", gap: 12 }}>
      <h2 style={{ margin: 0, color: WAVEX_COLOR }}>WaveX OS — preferences</h2>
      <p style={{ fontSize: 13, opacity: 0.7, margin: 0 }}>
        This panel reads data from the wavex-os op-omega-server and (optionally) the
        configured Supabase project. All actions still happen via Paperclip's native
        issue + agent flows. To change endpoints, edit the plugin instance config in
        Paperclip's Admin Panel.
      </p>

      <Card label="Subscription">
        {loading ? (
          <div style={{ opacity: 0.6 }}>Reading subscription state…</div>
        ) : !data?.configured ? (
          <div style={{ opacity: 0.7 }}>
            Supabase URL + publishable key not set. Configure them in the plugin
            instance config to enable subscription + marketplace insights.
          </div>
        ) : data.error ? (
          <div style={{ color: "#ff6b6b" }}>Couldn't read subscription state: {data.error}</div>
        ) : (
          <>
            <Row label="Active Expert Agent hires">{data.expertAgentsHired ?? 0}</Row>
            <Row label="Last Stripe webhook">
              {data.lastStripeWebhookAt
                ? `${new Date(data.lastStripeWebhookAt).toLocaleString()} (${data.lastStripeWebhookType ?? "?"})`
                : "no events yet"}
            </Row>
          </>
        )}
      </Card>

      <Card label="Where to go next">
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.7 }}>
          <li>
            <a href="http://localhost:5173/mission" style={{ color: WAVEX_COLOR }}>
              WaveX Mission Control
            </a>{" "}
            — KPI scoreboard, fleet graph, inception CTA.
          </li>
          <li>
            <a href="http://localhost:5173/pricing" style={{ color: WAVEX_COLOR }}>
              Expert Agent marketplace
            </a>{" "}
            — hire new catalog agents.
          </li>
          <li>
            See <code>docs/EXPERT_AGENT_MARKETPLACE_V2.md</code> in the wavex-os repo
            for the upcoming agent roster.
          </li>
        </ul>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiny in-bundle UI primitives (avoid a full design system dep — keeps bundle
// small and matches Paperclip's neutral host theme via CSS variables).
// ---------------------------------------------------------------------------

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section
      aria-label={label}
      style={{
        padding: "12px 14px",
        borderRadius: 6,
        border: `1px solid color-mix(in srgb, ${WAVEX_COLOR} 25%, transparent)`,
        background: WAVEX_BG,
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          opacity: 0.7,
          marginBottom: 8,
          color: WAVEX_COLOR,
        }}
      >
        {label}
      </div>
      {children}
    </section>
  );
}

function SkeletonCard({ label }: { label: string }) {
  return (
    <Card label={label}>
      <div style={{ opacity: 0.5 }}>Loading…</div>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: "4px 0",
        fontSize: 13,
      }}
    >
      <span style={{ opacity: 0.7 }}>{label}</span>
      <span>{children}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiny dependency-free chart primitives — inline CSS/SVG only. Deliberately
// not a charting library: the plugin is read-only and the bundle stays small.
// ---------------------------------------------------------------------------

/** Horizontal labelled bar — value relative to `max`, full-width track. */
function Bar({
  label,
  value,
  max,
  color,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div style={{ fontSize: 12 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 3,
        }}
      >
        <span style={{ opacity: 0.75, textTransform: "capitalize" }}>{label}</span>
        <span style={{ fontWeight: 600 }}>{value}</span>
      </div>
      <div
        style={{
          height: 8,
          borderRadius: 4,
          background: "rgba(255,255,255,0.06)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            borderRadius: 4,
            background: color,
            transition: "width 200ms ease",
          }}
        />
      </div>
    </div>
  );
}

/** Goal progress gauge — current → target, with a WAVEX-tinted fill bar. */
function ProgressGauge({
  label,
  current,
  target,
  unit,
}: {
  label: string;
  current: number;
  target: number;
  unit: string;
}) {
  const pct =
    target > 0 ? Math.max(0, Math.min(100, (current / target) * 100)) : 0;
  const reached = target > 0 && current >= target;
  const fill = reached ? "#4ade80" : WAVEX_COLOR;
  const suffix = unit ? ` ${unit}` : "";
  return (
    <div style={{ fontSize: 13 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 4,
        }}
      >
        <span style={{ fontWeight: 500 }}>{label}</span>
        <span style={{ opacity: 0.7 }}>
          {formatNum(current)}
          <span style={{ opacity: 0.5 }}> / {formatNum(target)}</span>
          {suffix}
        </span>
      </div>
      <div
        style={{
          height: 10,
          borderRadius: 5,
          background: "rgba(255,255,255,0.06)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            borderRadius: 5,
            background: `linear-gradient(90deg, color-mix(in srgb, ${fill} 55%, transparent), ${fill})`,
            transition: "width 250ms ease",
          }}
        />
      </div>
      <div style={{ fontSize: 11, opacity: 0.55, marginTop: 3 }}>
        {target > 0 ? `${Math.round(pct)}% of target` : "no target set"}
        {reached ? " — reached" : ""}
      </div>
    </div>
  );
}

/** Compact SVG donut — segments rendered as stroke-dasharray arcs. */
function DonutMini({
  segments,
  total,
  centerLabel,
}: {
  segments: Array<{ label: string; value: number; color: string }>;
  total: number;
  centerLabel: string;
}) {
  const size = 76;
  const stroke = 12;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`${total} ${centerLabel}`}
      style={{ flexShrink: 0 }}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="rgba(255,255,255,0.06)"
        strokeWidth={stroke}
      />
      {segments.map((s) => {
        if (s.value <= 0 || total <= 0) return null;
        const len = (s.value / total) * circumference;
        const seg = (
          <circle
            key={s.label}
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={s.color}
            strokeWidth={stroke}
            strokeDasharray={`${len} ${circumference - len}`}
            strokeDashoffset={-offset}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        );
        offset += len;
        return seg;
      })}
      <text
        x="50%"
        y="46%"
        textAnchor="middle"
        dominantBaseline="middle"
        fill={WAVEX_COLOR}
        style={{ fontSize: 18, fontWeight: 600 }}
      >
        {total}
      </text>
      <text
        x="50%"
        y="63%"
        textAnchor="middle"
        dominantBaseline="middle"
        fill="currentColor"
        style={{ fontSize: 8, opacity: 0.55, letterSpacing: "0.04em" }}
      >
        {centerLabel.toUpperCase()}
      </text>
    </svg>
  );
}
