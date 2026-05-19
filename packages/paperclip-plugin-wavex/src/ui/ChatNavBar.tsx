/** Mission Control — Chat-as-nav (Frontier F4).
 *
 *  Persistent bottom input bar on the full-page MC. The operator types
 *  a natural-language question; the server returns a STRUCTURED card
 *  payload; this component dispatches to the right surface:
 *
 *    kind="kpi"      → opens ReceiptsPanel for kpiId
 *    kind="decision" → calls onJumpToDecisions()
 *    kind="agent"    → shows an inline AgentCard (name + load)
 *    kind="text"     → shows an inline TextCard
 *
 *  Recent answers stack above the input (most-recent first) so the
 *  operator can revisit prior queries without re-typing. Keyboard:
 *  "/" or "⌘K" focuses the input.
 *
 *  Renders nothing if companyId is missing.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { usePluginAction, type PluginWidgetProps } from "@wavex-os/plugin-sdk-shim/ui";
import { ReceiptsPanel } from "./ReceiptsPanel.js";

const MINT = "#4ec9b0";
const TEXT = "rgba(255,255,255,0.92)";
const TEXT_MUTED = "rgba(255,255,255,0.62)";
const TEXT_DIM = "rgba(255,255,255,0.45)";
const SURFACE = "#0f1419";
const SURFACE_ALT = "rgba(255,255,255,0.04)";
const BORDER = "rgba(255,255,255,0.08)";
const BORDER_HOVER = "rgba(78, 201, 176, 0.35)";

type CardKind = "kpi" | "decision" | "agent" | "text";

interface AskResponse {
  ok: boolean;
  kind?: CardKind;
  payload?: Record<string, unknown>;
  preface?: string;
  generatedAt?: string;
  source?: "llm" | "fallback";
  error?: string;
}

interface ChatEntry {
  id: string;
  question: string;
  response: AskResponse | null;
  pending: boolean;
  error?: string;
  askedAt: string;
}

interface Props {
  context: PluginWidgetProps["context"];
  onJumpToDecisions?: () => void;
}

export function ChatNavBar({ context, onJumpToDecisions }: Props) {
  const companyId = context.companyId ?? "";
  const askAction = usePluginAction("mission-control-ask");
  const [question, setQuestion] = useState("");
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [receiptsKpi, setReceiptsKpi] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Global focus hotkey: "/" or "⌘K"
  useEffect(() => {
    if (!companyId) return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if (e.key === "/" && !inField) {
        e.preventDefault();
        inputRef.current?.focus();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [companyId]);

  const submit = useCallback(async () => {
    const q = question.trim();
    if (!q || !companyId) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const askedAt = new Date().toISOString();
    setEntries((prev) => [{ id, question: q, response: null, pending: true, askedAt }, ...prev].slice(0, 6));
    setQuestion("");
    try {
      const res = (await askAction({ companyId, question: q })) as AskResponse;
      setEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, response: res, pending: false } : e)),
      );
      // Auto-route the card
      if (res?.kind === "kpi" && typeof res.payload?.kpiId === "string") {
        setReceiptsKpi(res.payload.kpiId);
      } else if (res?.kind === "decision" && onJumpToDecisions) {
        onJumpToDecisions();
      }
    } catch (err) {
      setEntries((prev) =>
        prev.map((e) =>
          e.id === id ? { ...e, pending: false, error: err instanceof Error ? err.message : String(err) } : e,
        ),
      );
    }
  }, [askAction, companyId, question, onJumpToDecisions]);

  const dismiss = (id: string) => setEntries((prev) => prev.filter((e) => e.id !== id));

  if (!companyId) return null;

  return (
    <>
      <div
        style={{
          position: "sticky",
          bottom: 0,
          background: `linear-gradient(180deg, transparent 0%, ${SURFACE} 30%)`,
          padding: "16px 24px 18px",
          borderTop: `1px solid ${BORDER}`,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          zIndex: 20,
        }}
      >
        {/* Answer stack (above input) */}
        {entries.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 240, overflowY: "auto" }}>
            {entries.map((e) => (
              <AnswerCard
                key={e.id}
                entry={e}
                onOpenKpi={(kpiId) => setReceiptsKpi(kpiId)}
                onJumpToDecisions={onJumpToDecisions}
                onDismiss={() => dismiss(e.id)}
              />
            ))}
          </div>
        ) : null}

        {/* Input */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            background: SURFACE_ALT,
            border: `1px solid ${BORDER}`,
            borderRadius: 10,
            padding: "6px 10px 6px 14px",
          }}
        >
          <span aria-hidden style={{ color: MINT, fontSize: 14, fontWeight: 600 }}>↳</span>
          <input
            ref={inputRef}
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask Mission Control — e.g. 'what should I focus on?'"
            aria-label="Ask Mission Control"
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              color: TEXT,
              fontSize: 13,
              fontFamily: "inherit",
              outline: "none",
              padding: "8px 0",
            }}
          />
          <kbd
            style={{
              fontSize: 10,
              color: TEXT_DIM,
              padding: "2px 6px",
              borderRadius: 4,
              border: `1px solid ${BORDER}`,
              fontFamily: "ui-monospace, SFMono-Regular, monospace",
            }}
          >
            /
          </kbd>
          <button
            type="submit"
            disabled={!question.trim()}
            style={{
              padding: "6px 14px",
              fontSize: 12,
              fontWeight: 600,
              background: question.trim() ? `color-mix(in srgb, ${MINT} 22%, transparent)` : "transparent",
              color: question.trim() ? MINT : TEXT_DIM,
              border: `1px solid ${question.trim() ? BORDER_HOVER : BORDER}`,
              borderRadius: 8,
              cursor: question.trim() ? "pointer" : "not-allowed",
              fontFamily: "inherit",
            }}
          >
            Ask
          </button>
        </form>
      </div>

      <ReceiptsPanel
        companyId={companyId}
        kpiId={receiptsKpi}
        onClose={() => setReceiptsKpi(null)}
      />
    </>
  );
}

function AnswerCard({
  entry,
  onOpenKpi,
  onJumpToDecisions,
  onDismiss,
}: {
  entry: ChatEntry;
  onOpenKpi: (kpiId: string) => void;
  onJumpToDecisions?: () => void;
  onDismiss: () => void;
}) {
  const { question, response, pending, error } = entry;
  return (
    <div
      style={{
        background: SURFACE_ALT,
        border: `1px solid ${BORDER}`,
        borderRadius: 10,
        padding: "10px 14px",
      }}
    >
      {/* Question echo */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 11,
          color: TEXT_DIM,
        }}
      >
        <span style={{ color: MINT, fontWeight: 600 }}>You asked</span>
        <span style={{ color: TEXT_MUTED, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {question}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss answer"
          style={{
            background: "none",
            border: "none",
            color: TEXT_DIM,
            cursor: "pointer",
            fontSize: 16,
            padding: 0,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>

      {/* Response */}
      {pending ? (
        <div style={{ marginTop: 6, fontSize: 12, color: TEXT_MUTED }}>Thinking…</div>
      ) : error ? (
        <div style={{ marginTop: 6, fontSize: 12, color: "#ff6b6b" }}>{error}</div>
      ) : response?.ok === false ? (
        <div style={{ marginTop: 6, fontSize: 12, color: TEXT_MUTED }}>
          {response?.error ?? "I couldn't answer that one."}
        </div>
      ) : (
        <ResponseBody response={response} onOpenKpi={onOpenKpi} onJumpToDecisions={onJumpToDecisions} />
      )}
    </div>
  );
}

function ResponseBody({
  response,
  onOpenKpi,
  onJumpToDecisions,
}: {
  response: AskResponse | null;
  onOpenKpi: (kpiId: string) => void;
  onJumpToDecisions?: () => void;
}) {
  if (!response) return null;
  const preface = response.preface ?? "";
  return (
    <div style={{ marginTop: 8 }}>
      {preface ? (
        <div style={{ fontSize: 13, color: TEXT, lineHeight: 1.45, marginBottom: 6 }}>
          {preface}
        </div>
      ) : null}
      {response.kind === "text" ? (
        <div style={{ fontSize: 12, color: TEXT_MUTED, lineHeight: 1.5 }}>
          {String(response.payload?.answer ?? "")}
        </div>
      ) : response.kind === "kpi" ? (
        <button
          type="button"
          onClick={() => onOpenKpi(String(response.payload?.kpiId ?? ""))}
          style={cardButtonStyle}
        >
          Open receipts for <strong style={{ color: MINT }}>{String(response.payload?.kpiId ?? "")}</strong> →
        </button>
      ) : response.kind === "decision" ? (
        <button
          type="button"
          onClick={() => onJumpToDecisions?.()}
          style={cardButtonStyle}
        >
          Open the Decisions queue →
        </button>
      ) : response.kind === "agent" ? (
        <div
          style={{
            padding: "10px 12px",
            background: "rgba(255,255,255,0.02)",
            border: `1px solid ${BORDER}`,
            borderRadius: 8,
            fontSize: 12,
            color: TEXT_MUTED,
          }}
        >
          <strong style={{ color: TEXT }}>
            {String(response.payload?.nodeName ?? response.payload?.nodeId ?? "agent")}
          </strong>
        </div>
      ) : null}
    </div>
  );
}

const cardButtonStyle: React.CSSProperties = {
  background: "rgba(78, 201, 176, 0.08)",
  color: TEXT,
  border: `1px solid ${BORDER_HOVER}`,
  borderRadius: 8,
  padding: "10px 12px",
  fontSize: 12,
  cursor: "pointer",
  fontFamily: "inherit",
  textAlign: "left",
  width: "100%",
};
