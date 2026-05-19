/** Mission Control — Deliverable Inspector (Phase 3).
 *
 *  Modal-style drawer that opens when a deliverable is clicked from
 *  the Stream, Deliverables, or Impact views. Renders:
 *
 *    - header: title + kind + status + Reveal in Finder + Approve/Reject
 *    - provenance: produced by · task · expected KPI impact
 *    - body: mime-routed inline preview
 *
 *  Mime routing:
 *    text/markdown  → rendered as html (simple regex passes,
 *                     not a full md parser — keeps zero deps)
 *    text/html      → sandboxed iframe
 *    application/pdf→ <iframe src=...content URL...> (browsers
 *                     have built-in PDF viewer)
 *    image/*        → <img>
 *    video/*        → <video controls>
 *    audio/*        → <audio controls>
 *    application/json → syntax-highlighted via <pre>
 *    text/csv       → table render (first 100 rows)
 *    other          → "Open externally" button + raw size
 */

import { useEffect, useState } from "react";
import {
  usePluginAction,
  usePluginData,
} from "@paperclipai/plugin-sdk/ui";

const ACCENT = "#4ec9b0";
const SURFACE = "#0a0a18";
const SURFACE_ALT = "#15181d";
const BORDER = "rgba(255,255,255,0.08)";
const TEXT = "#e8eef2";
const TEXT_MUTED = "rgba(255,255,255,0.55)";

interface DeliverableRecord {
  id: string;
  instanceId: string;
  kind: string;
  title: string;
  description?: string;
  mimeType: string;
  sizeBytes: number;
  diskPath: string;
  relPath: string;
  contentHash: string;
  previewText?: string;
  status: string;
  reviewedAt?: string;
  reviewedByNodeId?: string;
  reviewNotes?: string;
  taskRef: { id: string; title: string; status: string };
  expectedKpiImpactRef?: string;
  templateUsed?: string;
  promptUsedRef?: string;
}
interface DeliverableResponse {
  ok: boolean;
  deliverable?: DeliverableRecord;
}

export function DeliverableInspector({
  companyId,
  deliverableId,
  onClose,
}: {
  companyId: string;
  deliverableId: string;
  onClose: () => void;
}) {
  const fetched = usePluginData<DeliverableResponse>(
    "mission-control-deliverable-detail",
    { id: deliverableId, companyId },
  );
  const reveal = usePluginAction("mission-control-deliverable-reveal");
  const review = usePluginAction("mission-control-deliverable-review");
  const [busy, setBusy] = useState<null | "reveal" | "approve" | "reject">(null);
  const [reviewNote, setReviewNote] = useState("");

  // ESC closes + body scroll lock
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const d = fetched.data?.deliverable;
  const loading = fetched.loading && !fetched.data;

  const handleReveal = async () => {
    setBusy("reveal");
    try {
      await reveal({ deliverableId });
    } finally {
      setBusy(null);
    }
  };
  const handleReview = async (decision: "approve" | "reject") => {
    setBusy(decision);
    try {
      await review({ deliverableId, decision, notes: reviewNote.trim() || undefined });
      await fetched.refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Deliverable inspector"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: 24,
      }}
    >
      <div
        style={{
          width: "min(960px, 95vw)",
          maxHeight: "92vh",
          background: SURFACE,
          borderRadius: 12,
          border: `1px solid ${BORDER}`,
          boxShadow: "0 30px 60px rgba(0,0,0,0.5)",
          display: "flex",
          flexDirection: "column",
          color: TEXT,
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <header style={{ padding: "18px 22px", borderBottom: `1px solid ${BORDER}`, display: "flex", alignItems: "flex-start", gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, opacity: 0.6, textTransform: "uppercase", letterSpacing: "0.04em" }}>
              {d?.kind ?? "deliverable"}
            </div>
            <h2 style={{ margin: "4px 0 0", fontSize: 18, fontWeight: 600, lineHeight: 1.3 }}>
              {loading ? "Loading…" : d?.title ?? "Not found"}
            </h2>
            {d ? (
              <div style={{ fontSize: 12, color: TEXT_MUTED, marginTop: 6, display: "flex", gap: 14 }}>
                <span>{d.mimeType}</span>
                <span>{formatBytes(d.sizeBytes)}</span>
                <span>status: <strong style={{ color: TEXT }}>{d.status}</strong></span>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ background: "none", border: "none", color: TEXT_MUTED, fontSize: 22, cursor: "pointer", padding: 4 }}
          >
            ×
          </button>
        </header>

        {/* Provenance */}
        {d ? (
          <div style={{ padding: "12px 22px", borderBottom: `1px solid ${BORDER}`, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, fontSize: 12 }}>
            <Field label="Task" value={d.taskRef.title || `(${d.taskRef.id.slice(0, 8)})`} />
            <Field label="KPI impact" value={d.expectedKpiImpactRef ?? "—"} />
            <Field label="Hash" value={d.contentHash.slice(0, 12)} mono />
          </div>
        ) : null}

        {/* Body */}
        <div style={{ flex: 1, overflow: "auto", padding: 22, background: SURFACE_ALT }}>
          {loading ? (
            <div style={{ color: TEXT_MUTED, fontSize: 13 }}>Loading…</div>
          ) : !d ? (
            <div style={{ color: TEXT_MUTED, fontSize: 13 }}>Deliverable not found.</div>
          ) : (
            <Preview deliverable={d} companyId={companyId} />
          )}
        </div>

        {/* Footer — actions */}
        {d ? (
          <footer style={{ padding: "12px 22px", borderTop: `1px solid ${BORDER}`, display: "flex", gap: 10, alignItems: "center" }}>
            <button
              type="button"
              onClick={handleReveal}
              disabled={busy !== null}
              style={btnGhost}
              aria-label="Reveal in Finder"
            >
              {busy === "reveal" ? "Opening…" : "Reveal in Finder"}
            </button>
            <input
              type="text"
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value)}
              placeholder="Review note (optional)"
              style={{ flex: 1, padding: "8px 12px", borderRadius: 6, background: SURFACE_ALT, border: `1px solid ${BORDER}`, color: TEXT, fontSize: 12, outline: "none" }}
            />
            <button
              type="button"
              onClick={() => handleReview("reject")}
              disabled={busy !== null}
              style={btnGhost}
            >
              {busy === "reject" ? "…" : "Request revision"}
            </button>
            <button
              type="button"
              onClick={() => handleReview("approve")}
              disabled={busy !== null}
              style={btnPrimary}
            >
              {busy === "approve" ? "…" : "Approve"}
            </button>
          </footer>
        ) : null}
      </div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10, textTransform: "uppercase", color: TEXT_MUTED, letterSpacing: "0.04em" }}>{label}</div>
      <div style={{ marginTop: 3, fontSize: 13, fontFamily: mono ? "ui-monospace, SFMono-Regular, monospace" : "inherit", color: TEXT, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {value}
      </div>
    </div>
  );
}

function Preview({ deliverable, companyId }: { deliverable: DeliverableRecord; companyId: string }) {
  const url = `/api/mission-control/deliverable/${encodeURIComponent(deliverable.id)}/content`;
  const mime = deliverable.mimeType;
  if (mime.startsWith("image/")) {
    return <img src={url} alt={deliverable.title} style={{ maxWidth: "100%", borderRadius: 6 }} />;
  }
  if (mime.startsWith("video/")) {
    return <video src={url} controls style={{ maxWidth: "100%", borderRadius: 6 }} />;
  }
  if (mime.startsWith("audio/")) {
    return <audio src={url} controls style={{ width: "100%" }} />;
  }
  if (mime === "application/pdf") {
    return <iframe src={url} title={deliverable.title} style={{ width: "100%", height: "70vh", border: 0, borderRadius: 6, background: "#fff" }} />;
  }
  if (mime === "text/html") {
    return <iframe src={url} title={deliverable.title} sandbox="" style={{ width: "100%", height: "70vh", border: 0, borderRadius: 6, background: "#fff" }} />;
  }
  if (mime === "text/markdown" || mime === "text/plain") {
    return <TextPreview deliverable={deliverable} url={url} markdown={mime === "text/markdown"} />;
  }
  if (mime === "application/json") {
    return <TextPreview deliverable={deliverable} url={url} jsonPretty />;
  }
  if (mime === "text/csv") {
    return <CsvPreview url={url} />;
  }
  // Fallback — show preview text if backend captured it, else metadata.
  if (deliverable.previewText) {
    return <pre style={preStyle}>{deliverable.previewText}</pre>;
  }
  return (
    <div style={{ color: TEXT_MUTED, fontSize: 13, padding: 12, textAlign: "center" }}>
      <div style={{ fontSize: 14, color: TEXT, marginBottom: 8 }}>Preview not available for {mime}</div>
      <div>Use Reveal in Finder to open the file in its native app.</div>
    </div>
  );
}

function TextPreview({
  url,
  markdown,
  jsonPretty,
  deliverable,
}: {
  url: string;
  markdown?: boolean;
  jsonPretty?: boolean;
  deliverable: DeliverableRecord;
}) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((t) => {
        if (cancelled) return;
        if (jsonPretty) {
          try {
            setText(JSON.stringify(JSON.parse(t), null, 2));
          } catch {
            setText(t);
          }
        } else {
          setText(t);
        }
      })
      .catch((e) => !cancelled && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [url, jsonPretty]);
  if (err) return <div style={{ color: "#ff6b6b", fontSize: 13 }}>{err}</div>;
  if (text === null && deliverable.previewText) {
    return <pre style={preStyle}>{deliverable.previewText}</pre>;
  }
  if (text === null) return <div style={{ color: TEXT_MUTED, fontSize: 13 }}>Loading…</div>;
  if (markdown) return <div style={preStyle as React.CSSProperties}>{renderSimpleMarkdown(text)}</div>;
  return <pre style={preStyle}>{text}</pre>;
}

function CsvPreview({ url }: { url: string }) {
  const [rows, setRows] = useState<string[][] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((t) => {
        if (cancelled) return;
        const lines = t.split(/\r?\n/).slice(0, 100);
        const parsed = lines.map((l) => l.split(","));
        setRows(parsed);
      })
      .catch((e) => !cancelled && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [url]);
  if (err) return <div style={{ color: "#ff6b6b", fontSize: 13 }}>{err}</div>;
  if (!rows) return <div style={{ color: TEXT_MUTED, fontSize: 13 }}>Loading…</div>;
  const [header, ...body] = rows;
  return (
    <div style={{ overflow: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "ui-monospace, monospace" }}>
        {header ? (
          <thead>
            <tr>
              {header.map((h, i) => (
                <th key={i} style={{ textAlign: "left", padding: "6px 8px", borderBottom: `1px solid ${BORDER}`, color: TEXT_MUTED }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {body.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci} style={{ padding: "5px 8px", borderBottom: `1px solid ${BORDER}` }}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length === 100 ? <div style={{ marginTop: 8, fontSize: 11, color: TEXT_MUTED }}>(showing first 100 rows)</div> : null}
    </div>
  );
}

/** Tiny markdown renderer — heads, paragraphs, code, bullets, links.
 *  Intentionally minimal to avoid a runtime dep. Anything more complex
 *  (tables, embeds) gracefully degrades to plain text. */
function renderSimpleMarkdown(src: string): React.ReactNode {
  const blocks = src.split(/\n\n+/);
  return blocks.map((b, i) => {
    if (b.startsWith("### ")) return <h3 key={i} style={{ margin: "16px 0 6px", fontSize: 16 }}>{b.slice(4)}</h3>;
    if (b.startsWith("## ")) return <h2 key={i} style={{ margin: "20px 0 8px", fontSize: 18 }}>{b.slice(3)}</h2>;
    if (b.startsWith("# ")) return <h1 key={i} style={{ margin: "20px 0 10px", fontSize: 22 }}>{b.slice(2)}</h1>;
    if (b.startsWith("```")) {
      const code = b.replace(/^```\w*\n?/, "").replace(/```$/, "");
      return <pre key={i} style={preStyle}>{code}</pre>;
    }
    if (b.split("\n").every((l) => /^[-*]\s/.test(l) || !l.trim())) {
      const items = b.split("\n").filter((l) => l.trim()).map((l) => l.replace(/^[-*]\s/, ""));
      return (
        <ul key={i} style={{ margin: "8px 0 8px 20px", padding: 0 }}>
          {items.map((it, j) => <li key={j} style={{ marginBottom: 4 }}>{it}</li>)}
        </ul>
      );
    }
    return <p key={i} style={{ margin: "8px 0", lineHeight: 1.55 }}>{b}</p>;
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const preStyle: React.CSSProperties = {
  margin: 0,
  padding: "12px 14px",
  borderRadius: 6,
  background: SURFACE,
  border: `1px solid ${BORDER}`,
  fontFamily: "ui-monospace, SFMono-Regular, monospace",
  fontSize: 12.5,
  lineHeight: 1.55,
  color: TEXT,
  overflow: "auto",
  whiteSpace: "pre-wrap",
};
const btnGhost: React.CSSProperties = {
  padding: "8px 14px",
  background: "transparent",
  border: `1px solid ${BORDER}`,
  borderRadius: 6,
  color: TEXT,
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "inherit",
};
const btnPrimary: React.CSSProperties = {
  padding: "8px 16px",
  background: ACCENT,
  border: "none",
  borderRadius: 6,
  color: "#020617",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "inherit",
};
