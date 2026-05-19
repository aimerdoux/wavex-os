/** Mission Control — Deliverables table widget (Phase 2).
 *
 *  Reverse-chrono list of every Deliverable the wavex side has written
 *  for the active company. Click a row → inline inspector drawer; the
 *  inspector dispatches on `DeliverableKind` so email_drafts render with
 *  subject/body, documents with full text, code with monospace, etc.
 *
 *  Polls `mission-control-deliverables` once on mount + on the user's
 *  manual refresh (real-time updates come via the existing Stream
 *  widget's `deliverable_produced` events, which the operator can
 *  watch alongside this table).
 */

import { useMemo, useState } from "react";
import { DeliverableInspector } from "./DeliverableInspector.js";
import {
  usePluginData,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import type {
  Deliverable,
  DeliverableKind,
  DeliverableStatus,
} from "@wavex-os/shared/types/mission-control";

const WAVEX_COLOR = "#00d4ff";
const WAVEX_BG = "color-mix(in srgb, #00d4ff 6%, transparent)";

interface DeliverablesResponse {
  ok: boolean;
  deliverables: Deliverable[];
  source?: string;
  error?: string;
}

const STATUS_TINT: Record<DeliverableStatus, string> = {
  draft: "#8a8f98",
  in_review: "#ffd166",
  approved: "#4ade80",
  rejected: "#ff6b6b",
  published: "#00d4ff",
};

const KIND_LABEL: Record<DeliverableKind, string> = {
  email_draft: "Email",
  message_draft: "Message",
  document: "Document",
  code: "Code",
  data_artifact: "Data",
  design_asset: "Design",
  audio_artifact: "Audio",
  database_record: "DB row",
  configuration: "Config",
  meeting_artifact: "Meeting",
  report: "Report",
  forecast: "Forecast",
};

function formatBytes(b: number): string {
  if (b < 1024) return `${b}b`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}kb`;
  return `${(b / (1024 * 1024)).toFixed(1)}mb`;
}

function formatRelative(at: string): string {
  const t = new Date(at).getTime();
  const delta = Math.max(0, Date.now() - t);
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

export function MissionControlDeliverablesWidget({
  context,
}: PluginWidgetProps) {
  const companyId = context.companyId ?? "";
  const { data, loading, error, refresh } = usePluginData<DeliverablesResponse>(
    "mission-control-deliverables",
    { companyId },
  );
  const [selected, setSelected] = useState<Deliverable | null>(null);
  const [kindFilter, setKindFilter] = useState<DeliverableKind | "all">("all");

  const items = useMemo(() => {
    if (!data?.deliverables) return [];
    return kindFilter === "all"
      ? data.deliverables
      : data.deliverables.filter((d) => d.kind === kindFilter);
  }, [data, kindFilter]);

  if (!companyId) {
    return (
      <Card label="Mission Control — Deliverables">
        <div style={{ opacity: 0.7 }}>Select a company.</div>
      </Card>
    );
  }
  if (loading && !data) {
    return (
      <Card label="Mission Control — Deliverables">
        <div style={{ opacity: 0.6 }}>Loading deliverables…</div>
      </Card>
    );
  }
  if (error) {
    return (
      <Card label="Mission Control — Deliverables">
        <div style={{ color: "#ff6b6b" }}>
          Couldn't load: {error.message}{" "}
          <button type="button" onClick={refresh} style={linkStyle}>
            retry
          </button>
        </div>
      </Card>
    );
  }

  return (
    <Card label="Mission Control — Deliverables">
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginBottom: 8,
          flexWrap: "wrap",
        }}
      >
        <select
          value={kindFilter}
          onChange={(e) =>
            setKindFilter(e.target.value as DeliverableKind | "all")
          }
          style={selectStyle}
        >
          <option value="all">All kinds</option>
          {(Object.keys(KIND_LABEL) as DeliverableKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <span style={{ fontSize: 12, opacity: 0.6 }}>
          {items.length} {items.length === 1 ? "deliverable" : "deliverables"}
        </span>
        <button type="button" onClick={refresh} style={{ ...linkStyle, marginLeft: "auto" }}>
          refresh
        </button>
      </div>
      {items.length === 0 ? (
        <div style={{ opacity: 0.7, padding: "12px 0", fontSize: 13 }}>
          No deliverables produced yet.
        </div>
      ) : (
        <table
          style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
        >
          <tbody>
            {items.map((d) => (
              <tr
                key={d.id}
                onClick={() => setSelected(d)}
                style={{
                  cursor: "pointer",
                  borderBottom: "1px solid rgba(255,255,255,0.05)",
                }}
              >
                <td style={{ padding: "8px 0", verticalAlign: "top" }}>
                  <div style={{ fontWeight: 500 }}>{d.title}</div>
                  <div
                    style={{
                      fontSize: 11,
                      opacity: 0.55,
                      marginTop: 2,
                      display: "flex",
                      gap: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <span>{KIND_LABEL[d.kind] ?? d.kind}</span>
                    <span>·</span>
                    <span>{formatRelative(d.producedAt)}</span>
                    <span>·</span>
                    <span>{formatBytes(d.sizeBytes)}</span>
                  </div>
                </td>
                <td
                  style={{
                    padding: "8px 0",
                    textAlign: "right",
                    verticalAlign: "top",
                    whiteSpace: "nowrap",
                  }}
                >
                  <StatusPill status={d.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {selected ? (
        <DeliverableInspector
          companyId={companyId}
          deliverableId={selected.id}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </Card>
  );
}

function StatusPill({ status }: { status: DeliverableStatus }) {
  const tint = STATUS_TINT[status];
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

function Inspector({
  deliverable,
  onClose,
}: {
  deliverable: Deliverable;
  onClose: () => void;
}) {
  return (
    <div
      style={{
        marginTop: 10,
        padding: 12,
        border: `1px solid color-mix(in srgb, ${WAVEX_COLOR} 30%, transparent)`,
        borderRadius: 6,
        background: "rgba(0, 212, 255, 0.04)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <strong>{deliverable.title}</strong>
        <button type="button" onClick={onClose} style={linkStyle}>
          close
        </button>
      </div>
      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
        {KIND_LABEL[deliverable.kind] ?? deliverable.kind} ·{" "}
        {formatRelative(deliverable.producedAt)} ·{" "}
        {formatBytes(deliverable.sizeBytes)} · hash{" "}
        {deliverable.contentHash.slice(0, 8)}
      </div>
      <KindBody deliverable={deliverable} />
      <div
        style={{
          marginTop: 10,
          paddingTop: 8,
          borderTop: "1px solid rgba(255,255,255,0.08)",
          fontSize: 11,
          opacity: 0.65,
          wordBreak: "break-all",
        }}
      >
        <strong style={{ color: WAVEX_COLOR }}>Disk path:</strong>{" "}
        {deliverable.diskPath}
      </div>
    </div>
  );
}

function KindBody({ deliverable }: { deliverable: Deliverable }) {
  const preview = deliverable.previewText ?? deliverable.description;
  // 5 kind-specific shells — others fall through to a generic preview.
  switch (deliverable.kind) {
    case "email_draft":
      return (
        <EmailPreview
          subject={deliverable.title}
          body={preview ?? "(no preview)"}
        />
      );
    case "message_draft":
      return (
        <MessagePreview
          title={deliverable.title}
          body={preview ?? "(no preview)"}
        />
      );
    case "document":
      return <DocumentPreview body={preview ?? "(no preview)"} />;
    case "code":
      return <CodePreview body={preview ?? "(no preview)"} />;
    case "data_artifact":
      return <DataPreview body={preview ?? "(no preview)"} />;
    default:
      return <DocumentPreview body={preview ?? "(no preview available)"} />;
  }
}

function EmailPreview({ subject, body }: { subject: string; body: string }) {
  return (
    <div style={{ marginTop: 8, fontSize: 13 }}>
      <div style={{ opacity: 0.7 }}>
        <strong style={{ opacity: 0.6 }}>Subject:</strong> {subject}
      </div>
      <pre style={preStyle}>{body}</pre>
    </div>
  );
}

function MessagePreview({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ marginTop: 8, fontSize: 13 }}>
      <div style={{ opacity: 0.7 }}>
        <strong style={{ opacity: 0.6 }}>Channel:</strong> {title}
      </div>
      <pre style={preStyle}>{body}</pre>
    </div>
  );
}

function DocumentPreview({ body }: { body: string }) {
  return <pre style={preStyle}>{body}</pre>;
}

function CodePreview({ body }: { body: string }) {
  return (
    <pre
      style={{
        ...preStyle,
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
        fontSize: 12,
      }}
    >
      {body}
    </pre>
  );
}

function DataPreview({ body }: { body: string }) {
  // Try to parse as JSON; fall back to raw.
  try {
    const parsed = JSON.parse(body);
    return (
      <pre
        style={{
          ...preStyle,
          fontFamily: "ui-monospace, SFMono-Regular, monospace",
          fontSize: 12,
        }}
      >
        {JSON.stringify(parsed, null, 2)}
      </pre>
    );
  } catch {
    return <pre style={preStyle}>{body}</pre>;
  }
}

function Card({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
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

const preStyle: React.CSSProperties = {
  marginTop: 6,
  padding: 8,
  background: "rgba(0,0,0,0.25)",
  borderRadius: 4,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: 240,
  overflowY: "auto",
};

const selectStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.04)",
  color: "currentColor",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 4,
  padding: "4px 8px",
  fontSize: 12,
};

const linkStyle: React.CSSProperties = {
  background: "none",
  color: WAVEX_COLOR,
  border: "none",
  cursor: "pointer",
  fontSize: 12,
  padding: 0,
};
