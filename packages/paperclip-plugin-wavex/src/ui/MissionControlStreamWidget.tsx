/** Mission Control — plain-language activity stream widget.
 *
 *  Phase 1.4 (the wedge). Renders one sentence per ActivityEvent in a
 *  reverse-chrono list, live-updated via `usePluginStream`. Mode-aware
 *  via the ScopeTree the worker hands back.
 *
 *  Data flow:
 *    1. `mission-control-activity` worker handler → initial page of events
 *       + ScopeTree lookup map + KPI catalog map for the renderers' ctx.
 *    2. `mission-control-stream` worker channel → SSE-pushed events as
 *       they're logged. New events prepend to the visible list (so the
 *       newest is on top and the user doesn't need to scroll up).
 *    3. Filter chips collapse the visible list locally — no extra fetch.
 *       Default window is "all kinds, all scopes, last 24h".
 *
 *  Renderers stay in `../renderers/` so the same sentence appears on
 *  every consumer (Stream widget today, Graph timeline tooltip later). */

import { useEffect, useMemo, useState } from "react";
import {
  usePluginAction,
  usePluginData,
  usePluginStream,
} from "@wavex-os/plugin-sdk-shim/ui";
import type {
  PluginBridgeError,
  PluginWidgetProps,
} from "@wavex-os/plugin-sdk-shim/ui";
import type {
  ActivityEvent,
  ActivityEventKind,
  KPI,
  ScopeNode,
  Deliverable,
  Task,
} from "@wavex-os/shared/types/mission-control";
import {
  renderEvent,
  type RenderContext,
} from "../renderers/index.js";

const WAVEX_COLOR = "#00d4ff";
const WAVEX_BG = "color-mix(in srgb, #00d4ff 6%, transparent)";

interface ScopeTreeEntry {
  id: string;
  name: string;
  kind: ScopeNode["kind"];
  parentId?: string;
  childIds?: string[];
}

interface ActivityResponse {
  ok: boolean;
  events: ActivityEvent[];
  scopeNodes: ScopeTreeEntry[];
  kpis: Array<{ id: string; name: string }>;
  mode: RenderContext["mode"];
  source?: string;
  error?: string;
}

type WindowChoice = "1h" | "24h" | "7d" | "all";
const WINDOW_LABELS: Record<WindowChoice, string> = {
  "1h": "Last hour",
  "24h": "Last 24h",
  "7d": "Last 7 days",
  all: "All time",
};

type KindGroup = "task" | "deliverable" | "node" | "kpi" | "chief" | "system";
const KIND_GROUP_PREFIX: Record<KindGroup, string[]> = {
  task: ["task_"],
  deliverable: ["deliverable_"],
  node: ["node_"],
  kpi: ["kpi_"],
  chief: ["chief_"],
  system: [
    "cost_",
    "integrity_",
    "mode_",
    "workspace_",
    "department_",
  ],
};

function kindGroupOf(kind: ActivityEventKind): KindGroup {
  for (const group of Object.keys(KIND_GROUP_PREFIX) as KindGroup[]) {
    if (KIND_GROUP_PREFIX[group].some((prefix) => kind.startsWith(prefix))) {
      return group;
    }
  }
  return "system";
}

function windowSinceMs(choice: WindowChoice): number | null {
  switch (choice) {
    case "1h":
      return 60 * 60 * 1000;
    case "24h":
      return 24 * 60 * 60 * 1000;
    case "7d":
      return 7 * 24 * 60 * 60 * 1000;
    case "all":
      return null;
  }
}

function formatRelative(at: string, now: number): string {
  const t = new Date(at).getTime();
  const delta = Math.max(0, now - t);
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

function severityColor(severity: ActivityEvent["severity"]): string {
  switch (severity) {
    case "critical":
      return "#ff6b6b";
    case "warning":
      return "#ffd166";
    case "notable":
      return WAVEX_COLOR;
    case "info":
      return "#8a8f98";
  }
}

function buildCtx(data: ActivityResponse): RenderContext {
  const byId = new Map<string, ScopeNode>();
  for (const n of data.scopeNodes) {
    byId.set(n.id, {
      id: n.id,
      kind: n.kind,
      name: n.name,
      parentId: n.parentId,
      childIds: n.childIds ?? [],
      metadata: {
        activeTaskCount: 0,
        kpisOwned: [],
        costThisPeriodUSD: 0,
      },
    });
  }
  const kpiCatalog = new Map<string, KPI>();
  for (const k of data.kpis) {
    kpiCatalog.set(k.id, {
      id: k.id,
      instanceId: "",
      name: k.name,
      type: "output",
      unit: "",
      target: 0,
      window: "day",
      source: { kind: "manual_input" },
      ownerNodeIds: [],
      history: [],
    });
  }
  return {
    mode: data.mode,
    scopeTree: { byId },
    kpiCatalog,
    taskCatalog: new Map<string, Task>(),
    deliverableCatalog: new Map<string, Deliverable>(),
  };
}

export function MissionControlStreamWidget({ context }: PluginWidgetProps) {
  const companyId = context.companyId ?? "";
  const { data, loading, error, refresh } = usePluginData<ActivityResponse>(
    "mission-control-activity",
    { companyId },
  );
  const stream = usePluginStream<ActivityEvent>(
    "mission-control-stream",
    companyId ? { companyId } : undefined,
  );
  const subscribe = usePluginAction("mission-control-stream-subscribe");
  const unsubscribe = usePluginAction("mission-control-stream-unsubscribe");

  // Tell the worker to start polling wavex for this company. The worker
  // owns the poll cadence + cursor; the widget just subscribes to the
  // resulting stream channel above.
  useEffect(() => {
    if (!companyId) return;
    void subscribe({ companyId }).catch(() => {
      // The widget already shows a "live offline" indicator if the stream
      // never connects — silent failure here is fine.
    });
    return () => {
      void unsubscribe({ companyId }).catch(() => {});
    };
  }, [companyId, subscribe, unsubscribe]);
  const [windowChoice, setWindowChoice] = useState<WindowChoice>("24h");
  const [activeGroups, setActiveGroups] = useState<Set<KindGroup>>(
    new Set(["task", "deliverable", "node", "kpi", "chief", "system"]),
  );
  const [query, setQuery] = useState("");

  const ctx = useMemo<RenderContext | null>(
    () => (data ? buildCtx(data) : null),
    [data],
  );

  const visibleEvents = useMemo(() => {
    if (!data || !ctx) return [];
    // Merge initial + live, dedupe by event.id, newest first.
    const merged = new Map<string, ActivityEvent>();
    for (const e of data.events) merged.set(e.id, e);
    for (const e of stream.events) merged.set(e.id, e);
    const list = Array.from(merged.values());
    list.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

    const since = windowSinceMs(windowChoice);
    const cutoff = since != null ? Date.now() - since : 0;
    const q = query.trim().toLowerCase();

    return list.filter((e) => {
      if (since != null && new Date(e.at).getTime() < cutoff) return false;
      if (!activeGroups.has(kindGroupOf(e.kind))) return false;
      if (q.length > 0) {
        const sentence = renderEvent(e, ctx).toLowerCase();
        if (!sentence.includes(q)) return false;
      }
      return true;
    });
  }, [data, stream.events, windowChoice, activeGroups, query, ctx]);

  if (!companyId) {
    return (
      <Card label="Mission Control — Activity Stream">
        <div style={{ opacity: 0.7 }}>
          Select a company to see its activity stream.
        </div>
      </Card>
    );
  }

  if (loading && !data) {
    return (
      <Card label="Mission Control — Activity Stream">
        <div style={{ opacity: 0.6 }}>Loading recent activity…</div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card label="Mission Control — Activity Stream">
        <ErrorRow error={error} onRetry={refresh} />
      </Card>
    );
  }

  return (
    <Card label="Mission Control — Activity Stream">
      <Toolbar
        windowChoice={windowChoice}
        onWindow={setWindowChoice}
        activeGroups={activeGroups}
        onToggleGroup={(g) => {
          setActiveGroups((prev) => {
            const next = new Set(prev);
            if (next.has(g)) next.delete(g);
            else next.add(g);
            return next;
          });
        }}
        query={query}
        onQuery={setQuery}
        live={stream.connected}
      />
      {visibleEvents.length === 0 ? (
        <div style={{ opacity: 0.7, padding: "12px 0", fontSize: 13 }}>
          {data?.events.length === 0
            ? "No activity yet. Events appear here as agents work."
            : "No events match the current filters."}
        </div>
      ) : (
        <ol
          style={{
            margin: 0,
            padding: 0,
            listStyle: "none",
            maxHeight: 420,
            overflowY: "auto",
          }}
        >
          {visibleEvents.map((event) => (
            <EventRow key={event.id} event={event} ctx={ctx!} />
          ))}
        </ol>
      )}
    </Card>
  );
}

function EventRow({
  event,
  ctx,
}: {
  event: ActivityEvent;
  ctx: RenderContext;
}) {
  const sentence = renderEvent(event, ctx);
  const now = Date.now();
  return (
    <li
      style={{
        display: "flex",
        gap: 8,
        padding: "8px 0",
        borderBottom: "1px solid rgba(255,255,255,0.05)",
        fontSize: 13,
        lineHeight: 1.45,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          marginTop: 7,
          borderRadius: 3,
          background: severityColor(event.severity),
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ wordBreak: "break-word" }}>{sentence}</div>
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
          <span>{formatRelative(event.at, now)}</span>
          <span style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>
            {event.kind}
          </span>
          {event.detailUrl ? (
            <a
              href={event.detailUrl}
              style={{ color: WAVEX_COLOR, textDecoration: "none" }}
            >
              details →
            </a>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function Toolbar({
  windowChoice,
  onWindow,
  activeGroups,
  onToggleGroup,
  query,
  onQuery,
  live,
}: {
  windowChoice: WindowChoice;
  onWindow: (w: WindowChoice) => void;
  activeGroups: Set<KindGroup>;
  onToggleGroup: (g: KindGroup) => void;
  query: string;
  onQuery: (q: string) => void;
  live: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        alignItems: "center",
        marginBottom: 8,
      }}
    >
      <select
        value={windowChoice}
        onChange={(e) => onWindow(e.target.value as WindowChoice)}
        style={selectStyle}
      >
        {(Object.keys(WINDOW_LABELS) as WindowChoice[]).map((w) => (
          <option key={w} value={w}>
            {WINDOW_LABELS[w]}
          </option>
        ))}
      </select>
      {(Object.keys(KIND_GROUP_PREFIX) as KindGroup[]).map((g) => (
        <Chip
          key={g}
          label={g}
          on={activeGroups.has(g)}
          onClick={() => onToggleGroup(g)}
        />
      ))}
      <input
        type="search"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Search…"
        style={{
          ...selectStyle,
          flex: 1,
          minWidth: 120,
        }}
      />
      <span
        title={live ? "Live stream connected" : "Live stream offline"}
        style={{
          fontSize: 10,
          color: live ? "#4ade80" : "#8a8f98",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontWeight: 600,
        }}
      >
        ● {live ? "live" : "offline"}
      </span>
    </div>
  );
}

function Chip({
  label,
  on,
  onClick,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "3px 8px",
        fontSize: 11,
        borderRadius: 4,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        cursor: "pointer",
        border: `1px solid ${
          on
            ? `color-mix(in srgb, ${WAVEX_COLOR} 55%, transparent)`
            : "rgba(255,255,255,0.12)"
        }`,
        background: on
          ? `color-mix(in srgb, ${WAVEX_COLOR} 18%, transparent)`
          : "transparent",
        color: on ? WAVEX_COLOR : "#8a8f98",
      }}
    >
      {label}
    </button>
  );
}

function ErrorRow({
  error,
  onRetry,
}: {
  error: PluginBridgeError;
  onRetry: () => void;
}) {
  return (
    <div style={{ color: "#ff6b6b", fontSize: 13 }}>
      Couldn't load activity: {error.message}{" "}
      <button
        type="button"
        onClick={onRetry}
        style={{
          marginLeft: 6,
          background: "none",
          color: WAVEX_COLOR,
          border: "none",
          cursor: "pointer",
          fontSize: 13,
          padding: 0,
        }}
      >
        retry
      </button>
    </div>
  );
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

const selectStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.04)",
  color: "currentColor",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 4,
  padding: "4px 8px",
  fontSize: 12,
};
