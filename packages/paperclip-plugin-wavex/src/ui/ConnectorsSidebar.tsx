/** Connectors — sidebar entry + Directory modal (v0.8.0).
 *
 *  Modeled on Claude.ai's connector directory:
 *    - A sidebar nav entry shows "Connectors (N)" where N = vaulted slugs.
 *    - Clicking it opens a portaled modal overlay with: search bar,
 *      filter/sort, grouped cards. Each card has a brand logo + name +
 *      "#N popular" badge + add (+) button.
 *    - Add triggers real OAuth via the existing
 *      POST /op-omega/onboarding/connectors/oauth/initiate route,
 *      opening the redirect URL in a new tab and polling the vault
 *      until the slug shows vaulted_valid (then the card flips to
 *      connected).
 *    - Disconnect calls DELETE /api/connectors/:companyId/:slug.
 *
 *  Backend reuse: connect/list/callback exist in op-omega-server's
 *  connectors.ts; connected-status + disconnect routes I added to
 *  credentials.ts. No new tables.
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  usePluginAction,
  usePluginData,
  type PluginSidebarProps,
} from "@wavex-os/plugin-sdk-shim/ui";

// Palette — Claude-style neutral surface with WaveX OS mint reserved
// for live/connected state. Claude's connector directory uses warm
// charcoal (not navy), generous card padding, no brand-tinted logo
// tiles, and a muted "+" glyph instead of a filled accent button.
const ACCENT = "#4ec9b0";        // WaveX OS mint — used for connected dot only
const ACCENT_INK = "#0f0f0f";
const SURFACE = "#1a1a1a";       // modal bg (warm charcoal, not indigo)
const SURFACE_ALT = "#252525";   // card bg (one notch lighter)
const SURFACE_HOVER = "#2c2c2c"; // card hover
const BORDER = "rgba(255,255,255,0.06)";
const BORDER_HOVER = "rgba(255,255,255,0.14)";
const TEXT = "#e8eaed";
const TEXT_MUTED = "rgba(255,255,255,0.55)";
const TEXT_DIM = "rgba(255,255,255,0.4)";
const MINT = "#4ec9b0";
const NEW_BADGE = "#f59e6e";     // warm orange for "New" pill

// ─── Types ─────────────────────────────────────────────────────────────

interface Toolkit {
  slug: string;
  displayName: string;
  category: string;
  logoUrl?: string;
  description?: string;
}
interface CatalogResponse {
  ok: boolean;
  source?: "composio" | "curated" | "fallback" | "error" | "unknown";
  toolkits?: Toolkit[];
}

interface SetupStatusResponse {
  ok: boolean;
  configured: boolean;
  valid: boolean;
  /** WaveX-managed mode: customer doesn't bring their own Composio key;
   *  the operator runs WaveX-as-a-service and provides the key server-side.
   *  When true, the directory skips the key-entry modal entirely and shows
   *  "Managed by WaveX" instead. The catalog still loads identically. */
  managed?: boolean;
  mode: "live" | "missing-key" | "disabled" | "key-rejected" | "validation-error" | "error";
  toolkitCount?: number;
  lastError?: string;
}
interface SetupResponse {
  ok: boolean;
  valid?: boolean;
  persisted?: boolean;
  toolkitCount?: number;
  warning?: string;
  error?: string;
}

type VaultStatus = "vaulted_valid" | "vaulted_unvalidated" | "skipped" | "pending";
interface ConnectedRow {
  slug: string;
  status: VaultStatus;
  vaultedKeys: string[];
  lastTestedAt: string | null;
}
interface ConnectedResponse {
  ok: boolean;
  rows?: ConnectedRow[];
}

interface ConnectResult {
  ok: boolean;
  redirectUrl?: string | null;
  pendingConnectionId?: string | null;
  needsLiveWiring?: boolean;
  error?: string;
  status?: number;
}

// Popularity rank (anchors the "#N popular" badge). Mirrors Claude's
// curated ordering — highest-impact integrations first.
const POPULARITY: Record<string, number> = {
  gmail: 1,
  slack: 2,
  google_calendar: 3,
  notion: 4,
  github: 5,
  hubspot: 6,
  google_drive: 7,
  linear: 8,
  outlook: 9,
  stripe: 10,
};

// One-line descriptions for the curated set. Hub responses may override.
const DESCRIPTIONS: Record<string, string> = {
  gmail: "Draft replies, summarize threads, & search your inbox",
  slack: "Post messages, search channels, summarize threads",
  google_calendar: "Manage your schedule and coordinate meetings effortlessly",
  notion: "Search, update, and power workflows across docs",
  github: "Read repos, open PRs, triage issues",
  hubspot: "Sync contacts, deals, and pipeline updates",
  google_drive: "Search, read, and upload files instantly",
  linear: "Triage issues, plan cycles, ship faster",
  outlook: "Read mail, draft replies, schedule sends",
  stripe: "Query customers, payments, and subscriptions",
  discord: "Post messages and pull server activity",
  telegram: "Send messages, read updates from chats",
  salesforce: "Sync accounts, opportunities, and activities",
  mixpanel: "Pull product analytics + funnels",
  amplitude: "Query user behavior + experiments",
  microsoft_calendar: "Read your Outlook calendar, schedule meetings",
};

// Brand colors for monogram fallback when logoUrl missing.
const BRAND_COLORS: Record<string, string> = {
  slack: "#4A154B",
  telegram: "#229ED9",
  discord: "#5865F2",
  gmail: "#EA4335",
  outlook: "#0078D4",
  hubspot: "#FF7A59",
  salesforce: "#00A1E0",
  stripe: "#635BFF",
  mixpanel: "#7856FF",
  amplitude: "#1E61F0",
  github: "#24292F",
  linear: "#5E6AD2",
  notion: "#000000",
  google_calendar: "#1A73E8",
  microsoft_calendar: "#0078D4",
  google_drive: "#1FA463",
};

// Category labels for grouping.
const CATEGORY_ORDER = [
  "comms",
  "crm",
  "billing",
  "analytics",
  "dev",
  "ops",
] as const;
const CATEGORY_LABELS: Record<string, string> = {
  comms: "Communication",
  crm: "CRM & Sales",
  billing: "Payments",
  analytics: "Analytics",
  dev: "Dev Tools",
  ops: "Productivity",
};

// ─── Sidebar Entry (default export of the slot) ────────────────────────

export function ConnectorsSidebarEntry({ context }: PluginSidebarProps) {
  const companyId = context.companyId ?? "";
  const [open, setOpen] = useState(false);
  const connected = usePluginData<ConnectedResponse>(
    "connectors-connected",
    { companyId },
  );
  const activeCount = (connected.data?.rows ?? []).filter(
    (r) => r.status === "vaulted_valid" || r.status === "vaulted_unvalidated",
  ).length;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!companyId}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "8px 10px",
          borderRadius: 4,
          border: `1px solid ${BORDER}`,
          background: "transparent",
          color: "inherit",
          cursor: companyId ? "pointer" : "not-allowed",
          fontSize: 13,
          opacity: companyId ? 1 : 0.5,
        }}
        aria-label={`Open connectors directory (${activeCount} connected)`}
      >
        <PlugIcon />
        <span style={{ flex: 1, textAlign: "left" }}>Connectors</span>
        {activeCount > 0 ? (
          <span
            style={{
              fontSize: 11,
              padding: "1px 6px",
              borderRadius: 8,
              background: `color-mix(in srgb, ${ACCENT} 18%, transparent)`,
              color: ACCENT,
              fontWeight: 600,
            }}
          >
            {activeCount}
          </span>
        ) : null}
      </button>
      {open && companyId
        ? createPortal(
            <DirectoryModal
              companyId={companyId}
              onClose={() => setOpen(false)}
              onChanged={() => connected.refresh()}
            />,
            document.body,
          )
        : null}
    </>
  );
}

// ─── Directory Modal ───────────────────────────────────────────────────

function DirectoryModal({
  companyId,
  onClose,
  onChanged,
}: {
  companyId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const setupStatus = usePluginData<SetupStatusResponse>("connectors-setup-status", {});
  const catalog = usePluginData<CatalogResponse>("connectors-catalog", {});
  const connected = usePluginData<ConnectedResponse>(
    "connectors-connected",
    { companyId },
  );
  const connect = usePluginAction("connectors-connect");
  const disconnect = usePluginAction("connectors-disconnect");

  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [polling, setPolling] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  // Filter + sort state. Category is a single-pick string ("all" for
  // unfiltered); statusFilter narrows to connected/available; sort
  // controls the ordering applied inside each category group.
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "connected" | "available">("all");
  const [sortMode, setSortMode] = useState<"default" | "popular" | "alpha">("default");
  const searchRef = useRef<HTMLInputElement | null>(null);

  // ESC + focus + body lock
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Defer focus so the input is mounted.
    queueMicrotask(() => searchRef.current?.focus());
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  // Poll for connection completion when an OAuth flow is in flight.
  // The refresh() call swaps the `connected.data` prop; the second
  // effect below watches that and clears polling state when the slug
  // appears in the vaulted set.
  useEffect(() => {
    if (!polling) return;
    const interval = setInterval(() => {
      void connected.refresh();
    }, 2500);
    const safety = setTimeout(() => setPolling(null), 5 * 60_000);
    return () => {
      clearInterval(interval);
      clearTimeout(safety);
    };
  }, [polling, connected]);

  useEffect(() => {
    if (!polling) return;
    const rows = connected.data?.rows ?? [];
    const ok = rows.some(
      (r) =>
        r.slug === polling &&
        (r.status === "vaulted_valid" || r.status === "vaulted_unvalidated"),
    );
    if (ok) {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(polling);
        return next;
      });
      setPolling(null);
      onChanged();
    }
  }, [polling, connected.data, onChanged]);

  const connectedSlugs = useMemo(() => {
    const set = new Set<string>();
    for (const r of connected.data?.rows ?? []) {
      if (r.status === "vaulted_valid" || r.status === "vaulted_unvalidated") {
        set.add(r.slug);
      }
    }
    return set;
  }, [connected.data]);

  const toolkits = catalog.data?.toolkits ?? [];

  // Distinct categories present in the catalog — drives the Filter menu.
  const availableCategories = useMemo(() => {
    const set = new Set<string>();
    for (const t of toolkits) if (t.category) set.add(t.category);
    return Array.from(set).sort();
  }, [toolkits]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return toolkits.filter((t) => {
      // Search
      if (q) {
        const hay = `${t.slug} ${t.displayName} ${CATEGORY_LABELS[t.category] ?? ""} ${DESCRIPTIONS[t.slug] ?? ""} ${t.description ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      // Category
      if (categoryFilter !== "all" && t.category !== categoryFilter) return false;
      // Status
      if (statusFilter === "connected" && !connectedSlugs.has(t.slug)) return false;
      if (statusFilter === "available" && connectedSlugs.has(t.slug)) return false;
      return true;
    });
  }, [toolkits, query, categoryFilter, statusFilter, connectedSlugs]);

  // Sort helper applied either inside category groups (default) OR
  // across the full filtered list (popular / alpha — they don't group).
  const applySort = (list: Toolkit[]) => {
    if (sortMode === "alpha") {
      return [...list].sort((a, b) => a.displayName.localeCompare(b.displayName));
    }
    if (sortMode === "popular") {
      return [...list].sort((a, b) => {
        const ap = POPULARITY[a.slug] ?? 999;
        const bp = POPULARITY[b.slug] ?? 999;
        if (ap !== bp) return ap - bp;
        return a.displayName.localeCompare(b.displayName);
      });
    }
    // default: connected first, then popularity, then alpha
    return [...list].sort((a, b) => {
      const aOn = connectedSlugs.has(a.slug);
      const bOn = connectedSlugs.has(b.slug);
      if (aOn !== bOn) return aOn ? -1 : 1;
      const ap = POPULARITY[a.slug] ?? 999;
      const bp = POPULARITY[b.slug] ?? 999;
      if (ap !== bp) return ap - bp;
      return a.displayName.localeCompare(b.displayName);
    });
  };

  const grouped = useMemo(() => {
    // Non-default sort flattens (single "All" group) so the user's
    // chosen order isn't fragmented across category headers.
    if (sortMode !== "default") {
      return [
        {
          category: "all",
          label: "Results",
          items: applySort(filtered),
        },
      ];
    }
    const map = new Map<string, Toolkit[]>();
    for (const t of filtered) {
      const cat = t.category || "other";
      const list = map.get(cat) ?? [];
      list.push(t);
      map.set(cat, list);
    }
    for (const list of map.values()) {
      list.splice(0, list.length, ...applySort(list));
    }
    const orderedKeys = [
      ...CATEGORY_ORDER.filter((k) => map.has(k)),
      ...Array.from(map.keys())
        .filter((k) => !CATEGORY_ORDER.includes(k as never))
        .sort(),
    ];
    return orderedKeys.map((k) => ({
      category: k,
      label: CATEGORY_LABELS[k] ?? k,
      items: map.get(k)!,
    }));
    // applySort is stable for given inputs — no need to memoize separately
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sortMode, connectedSlugs]);

  // True when any filter or non-default sort is active — used to show
  // the active-filter indicator dot on the Filter chip.
  const filterActive = categoryFilter !== "all" || statusFilter !== "all";
  const sortActive = sortMode !== "default";

  const handleConnect = async (slug: string) => {
    setBusy((prev) => new Set(prev).add(slug));
    setBanner(null);
    try {
      const res = (await connect({ companyId, slug })) as ConnectResult;
      if (res?.ok && res.redirectUrl) {
        window.open(res.redirectUrl, "_blank", "noopener,noreferrer");
        setPolling(slug);
        setBanner({
          kind: "info",
          text: `Opening ${slug} OAuth in a new tab. The card will flip to connected once Composio confirms.`,
        });
      } else {
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(slug);
          return next;
        });
        setBanner({
          kind: "error",
          text:
            res?.error ??
            (res?.needsLiveWiring
              ? "Composio is disabled in this environment. Set COMPOSIO_API_KEY + WAVEX_COMPOSIO_DISABLED=0 to enable live OAuth."
              : `Could not initiate ${slug}. Backend returned no redirect URL.`),
        });
      }
    } catch (err) {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(slug);
        return next;
      });
      setBanner({
        kind: "error",
        text: `Connect failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const handleDisconnect = async (slug: string) => {
    setBusy((prev) => new Set(prev).add(slug));
    try {
      await disconnect({ companyId, slug });
      await connected.refresh();
      onChanged();
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(slug);
        return next;
      });
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Connectors directory"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: 24,
        animation: "fadeIn 180ms ease",
      }}
    >
      <div
        style={{
          width: "min(1100px, 92vw)",
          height: "min(820px, 88vh)",
          background: SURFACE,
          borderRadius: 12,
          border: `1px solid ${BORDER}`,
          boxShadow: "0 30px 60px rgba(0,0,0,0.45)",
          display: "flex",
          flexDirection: "column",
          color: TEXT,
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "20px 28px 16px",
            borderBottom: `1px solid ${BORDER}`,
          }}
        >
          <span style={{ fontSize: 24, fontWeight: 600, flex: 1, letterSpacing: "-0.01em" }}>
            Directory
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close directory"
            style={{
              background: "none",
              border: "none",
              color: TEXT_MUTED,
              cursor: "pointer",
              fontSize: 18,
              padding: 4,
            }}
          >
            ×
          </button>
        </div>

        {/* Body — single Connectors surface (Skills/Plugins removed) */}
        {/* `minHeight: 0` is the load-bearing fix for inner scroll. Without
         *  it the flex child grows to fit content and the inner
         *  overflow: auto never kicks in (intrinsic height wins). */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            minHeight: 0,
          }}
        >
          {banner ? (
            <div
              role={banner.kind === "error" ? "alert" : "status"}
              style={{
                margin: "10px 20px 0",
                padding: "8px 12px",
                borderRadius: 5,
                fontSize: 12,
                lineHeight: 1.4,
                background:
                  banner.kind === "error"
                    ? "color-mix(in srgb, #ff6b6b 14%, transparent)"
                    : `color-mix(in srgb, ${ACCENT} 14%, transparent)`,
                border: `1px solid ${
                  banner.kind === "error"
                    ? "color-mix(in srgb, #ff6b6b 40%, transparent)"
                    : `color-mix(in srgb, ${ACCENT} 35%, transparent)`
                }`,
                color: banner.kind === "error" ? "#ffb4b4" : TEXT,
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
              }}
            >
              <span aria-hidden style={{ flexShrink: 0 }}>
                {banner.kind === "error" ? "⚠" : "ⓘ"}
              </span>
              <span style={{ flex: 1 }}>{banner.text}</span>
              <button
                type="button"
                onClick={() => setBanner(null)}
                aria-label="Dismiss"
                style={{
                  background: "none",
                  border: "none",
                  color: "currentColor",
                  cursor: "pointer",
                  fontSize: 14,
                  padding: 0,
                  opacity: 0.7,
                }}
              >
                ×
              </button>
            </div>
          ) : null}
          {setupStatus.loading && !setupStatus.data ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: TEXT_MUTED, fontSize: 14 }}>
              Checking Composio…
            </div>
          ) : (!setupStatus.data?.valid && !setupStatus.data?.managed) ? (
            // SetupScreen only renders when there's something the *user*
            // can do — paste a key. In WaveX-managed mode (operator runs
            // WaveX-as-a-service, customer never holds the Composio key)
            // we always fall through to the catalog, even if `valid: false`.
            // An empty/degraded catalog is the right signal — "Composio
            // is temporarily unavailable, your subscription covers it
            // when it's back" — not "go enter your own key here".
            <SetupScreen
              status={setupStatus.data}
              onComplete={() => {
                void setupStatus.refresh();
                void catalog.refresh();
              }}
            />
          ) : (
          <>
                {/* Search row */}
                <div
                  style={{
                    padding: "16px 28px 8px",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <div
                    style={{
                      flex: 1,
                      position: "relative",
                      display: "flex",
                      alignItems: "center",
                    }}
                  >
                    <div
                      style={{
                        position: "absolute",
                        left: 16,
                        top: "50%",
                        transform: "translateY(-50%)",
                        color: TEXT_MUTED,
                      }}
                      aria-hidden
                    >
                      <SearchIcon />
                    </div>
                    <input
                      ref={searchRef}
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search connectors…"
                      aria-label="Search connectors"
                      style={{
                        width: "100%",
                        padding: "14px 16px 14px 44px",
                        background: SURFACE_ALT,
                        border: `1px solid ${BORDER}`,
                        borderRadius: 10,
                        color: TEXT,
                        fontSize: 14,
                        outline: "none",
                      }}
                    />
                  </div>
                </div>

                {/* Group chip + Filter / Sort menus */}
                <div
                  style={{
                    padding: "8px 28px 4px",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                  }}
                >
                  <span
                    style={{
                      display: "inline-block",
                      padding: "6px 14px",
                      borderRadius: 999,
                      background: SURFACE_ALT,
                      border: `1px solid ${BORDER}`,
                      fontSize: 13,
                      color: TEXT,
                      flexShrink: 0,
                    }}
                  >
                    {catalog.data?.source === "composio"
                      ? "Composio · live catalog"
                      : catalog.data?.source === "curated"
                        ? "WaveX · curated fallback"
                        : "Catalog"}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      color: TEXT_MUTED,
                      flex: 1,
                    }}
                  >
                    {filtered.length} of {toolkits.length}
                  </span>
                  <DropdownMenu
                    label="Filter by"
                    active={filterActive}
                    onClear={
                      filterActive
                        ? () => {
                            setCategoryFilter("all");
                            setStatusFilter("all");
                          }
                        : undefined
                    }
                  >
                    <DropdownGroup label="Status">
                      <DropdownItem
                        label="All"
                        selected={statusFilter === "all"}
                        onClick={() => setStatusFilter("all")}
                      />
                      <DropdownItem
                        label="Connected"
                        selected={statusFilter === "connected"}
                        onClick={() => setStatusFilter("connected")}
                      />
                      <DropdownItem
                        label="Available"
                        selected={statusFilter === "available"}
                        onClick={() => setStatusFilter("available")}
                      />
                    </DropdownGroup>
                    {availableCategories.length > 0 ? (
                      <DropdownGroup label="Category">
                        <DropdownItem
                          label="All categories"
                          selected={categoryFilter === "all"}
                          onClick={() => setCategoryFilter("all")}
                        />
                        {availableCategories.map((c) => (
                          <DropdownItem
                            key={c}
                            label={CATEGORY_LABELS[c] ?? c}
                            selected={categoryFilter === c}
                            onClick={() => setCategoryFilter(c)}
                          />
                        ))}
                      </DropdownGroup>
                    ) : null}
                  </DropdownMenu>
                  <DropdownMenu label="Sort by" active={sortActive}>
                    <DropdownItem
                      label="Default"
                      selected={sortMode === "default"}
                      onClick={() => setSortMode("default")}
                    />
                    <DropdownItem
                      label="Popular"
                      selected={sortMode === "popular"}
                      onClick={() => setSortMode("popular")}
                    />
                    <DropdownItem
                      label="Alphabetical"
                      selected={sortMode === "alpha"}
                      onClick={() => setSortMode("alpha")}
                    />
                  </DropdownMenu>
                </div>

                {/* Grid body */}
                <div
                  style={{
                    flex: 1,
                    overflowY: "auto",
                    padding: "12px 28px 28px",
                  }}
                >
                  {catalog.loading && !catalog.data ? (
                    <div style={{ color: TEXT_MUTED, padding: 12 }}>
                      Loading catalog…
                    </div>
                  ) : grouped.length === 0 ? (
                    <EmptyState onClear={() => setQuery("")} />
                  ) : (
                    grouped.map((g) => (
                      <section key={g.category} style={{ marginBottom: 22 }}>
                        <div
                          style={{
                            fontSize: 11,
                            textTransform: "uppercase",
                            letterSpacing: "0.06em",
                            color: TEXT_MUTED,
                            marginBottom: 8,
                          }}
                        >
                          {g.label}{" "}
                          <span style={{ opacity: 0.6 }}>· {g.items.length}</span>
                        </div>
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns:
                              "repeat(auto-fill, minmax(440px, 1fr))",
                            gap: 12,
                          }}
                        >
                          {g.items.map((t) => (
                            <ConnectorCard
                              key={t.slug}
                              toolkit={t}
                              connected={connectedSlugs.has(t.slug)}
                              busy={busy.has(t.slug)}
                              polling={polling === t.slug}
                              onConnect={() => handleConnect(t.slug)}
                              onDisconnect={() => handleDisconnect(t.slug)}
                            />
                          ))}
                        </div>
                      </section>
                    ))
                  )}
                </div>
              </>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "14px 28px",
            borderTop: `1px solid ${BORDER}`,
            fontSize: 11,
            color: TEXT_MUTED,
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>
            {connectedSlugs.size} connected ·{" "}
            {toolkits.length - connectedSlugs.size} available
          </span>
          <span>esc to close · click outside to dismiss</span>
        </div>
      </div>
      <style>{`
        @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
      `}</style>
    </div>
  );
}

// ─── Connector Card ────────────────────────────────────────────────────

function ConnectorCard({
  toolkit,
  connected,
  busy,
  polling,
  onConnect,
  onDisconnect,
}: {
  toolkit: Toolkit;
  connected: boolean;
  busy: boolean;
  polling: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const popularRank = POPULARITY[toolkit.slug];
  const desc = toolkit.description || DESCRIPTIONS[toolkit.slug] || "";
  return (
    <button
      type="button"
      onClick={connected ? onDisconnect : onConnect}
      disabled={busy}
      aria-label={`${connected ? "Disconnect" : "Connect"} ${toolkit.displayName}`}
      style={{
        padding: "20px 22px",
        background: SURFACE_ALT,
        borderRadius: 12,
        border: `1px solid ${BORDER}`,
        display: "flex",
        flexDirection: "column",
        gap: 14,
        transition: "background 150ms ease, border-color 150ms ease",
        cursor: busy ? "wait" : "pointer",
        textAlign: "left",
        color: "inherit",
        width: "100%",
        font: "inherit",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = SURFACE_HOVER;
        e.currentTarget.style.borderColor = BORDER_HOVER;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = SURFACE_ALT;
        e.currentTarget.style.borderColor = BORDER;
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <LogoMark toolkit={toolkit} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 16,
              fontWeight: 600,
              color: TEXT,
              display: "flex",
              alignItems: "center",
              gap: 8,
              lineHeight: 1.2,
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {toolkit.displayName}
            </span>
            {connected ? (
              <span
                title="Connected"
                style={{ color: MINT, fontSize: 11, flexShrink: 0 }}
              >
                ●
              </span>
            ) : null}
          </div>
          {popularRank ? (
            <div style={{ fontSize: 13, color: TEXT_DIM, marginTop: 4 }}>
              #{popularRank} popular
            </div>
          ) : null}
        </div>
        <span
          aria-hidden
          style={{
            flexShrink: 0,
            width: 24,
            height: 24,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: connected ? TEXT_MUTED : TEXT_DIM,
            fontSize: 22,
            fontWeight: 300,
            lineHeight: 1,
            transition: "color 150ms ease",
          }}
        >
          {connected ? "✓" : polling ? "⟳" : busy ? "…" : "+"}
        </span>
      </div>
      {desc ? (
        <div
          style={{
            fontSize: 14,
            color: TEXT_MUTED,
            lineHeight: 1.5,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {desc}
        </div>
      ) : null}
    </button>
  );
}

// ─── LogoMark (monogram fallback for missing logoUrl) ──────────────────

function LogoMark({ toolkit }: { toolkit: Toolkit }) {
  // Claude-style: logo floats on a subtle neutral tile, NOT a
  // brand-color tinted background. Image is `contain` so wide logos
  // aren't cropped. Falls back to a clean monogram tile if no URL.
  const tileStyle: React.CSSProperties = {
    width: 40,
    height: 40,
    borderRadius: 10,
    flexShrink: 0,
    background: "rgba(255,255,255,0.04)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  };
  if (toolkit.logoUrl) {
    return (
      <div aria-hidden style={tileStyle}>
        <img
          src={toolkit.logoUrl}
          alt=""
          style={{
            width: 28,
            height: 28,
            objectFit: "contain",
          }}
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      </div>
    );
  }
  const initials = toolkit.displayName
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
  return (
    <div
      aria-hidden
      style={{
        ...tileStyle,
        fontSize: 13,
        fontWeight: 600,
        color: TEXT_MUTED,
      }}
    >
      {initials || "?"}
    </div>
  );
}

// ─── Empty state ───────────────────────────────────────────────────────

function SetupScreen({
  status,
  onComplete,
}: {
  status: SetupStatusResponse | null | undefined;
  onComplete: () => void;
}) {
  const setup = usePluginAction("connectors-setup");
  const [apiKey, setApiKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = apiKey.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = (await setup({ apiKey: trimmed })) as SetupResponse;
      if (res?.ok && res.valid) {
        onComplete();
      } else {
        setError(res?.error ?? "Could not validate the key. Try another.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const priorError = status?.mode === "key-rejected" || status?.mode === "validation-error"
    ? status.lastError
    : null;

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "32px 28px",
        overflowY: "auto",
      }}
    >
      <div style={{ maxWidth: 460, width: "100%" }}>
        <div
          aria-hidden
          style={{
            width: 56,
            height: 56,
            borderRadius: 14,
            background: `color-mix(in srgb, ${MINT} 12%, transparent)`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 20,
            color: MINT,
          }}
        >
          <PlugIcon />
        </div>
        <h2 style={{ fontSize: 22, fontWeight: 600, margin: "0 0 8px", color: TEXT, letterSpacing: "-0.01em" }}>
          Connect Composio to unlock integrations
        </h2>
        <p style={{ fontSize: 14, color: TEXT_MUTED, lineHeight: 1.55, margin: "0 0 24px" }}>
          Composio brokers OAuth for 900+ apps — Gmail, Slack, HubSpot,
          and more. Paste an API key from your Composio dashboard to
          unlock the connector directory.
        </p>

        <form onSubmit={handleSubmit}>
          <label
            htmlFor="composio-key"
            style={{
              display: "block",
              fontSize: 12,
              fontWeight: 500,
              color: TEXT_MUTED,
              marginBottom: 8,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            Composio API key
          </label>
          <input
            id="composio-key"
            type="password"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              if (error) setError(null);
            }}
            placeholder="ak_..."
            autoComplete="off"
            spellCheck={false}
            disabled={submitting}
            style={{
              width: "100%",
              padding: "12px 14px",
              fontSize: 14,
              borderRadius: 10,
              background: SURFACE_ALT,
              border: `1px solid ${error ? "rgba(255,107,107,0.5)" : BORDER}`,
              color: TEXT,
              outline: "none",
              fontFamily: "ui-monospace, SFMono-Regular, monospace",
            }}
          />
          {error || priorError ? (
            <div
              role="alert"
              style={{
                marginTop: 10,
                padding: "10px 12px",
                fontSize: 13,
                borderRadius: 8,
                background: "color-mix(in srgb, #ff6b6b 12%, transparent)",
                border: "1px solid rgba(255,107,107,0.35)",
                color: "#ffb4b4",
                lineHeight: 1.5,
              }}
            >
              {error ?? priorError}
            </div>
          ) : null}
          <button
            type="submit"
            disabled={submitting || apiKey.trim().length === 0}
            style={{
              marginTop: 16,
              width: "100%",
              padding: "12px 18px",
              fontSize: 14,
              fontWeight: 600,
              borderRadius: 10,
              border: "none",
              background: submitting || apiKey.trim().length === 0 ? SURFACE_ALT : MINT,
              color: submitting || apiKey.trim().length === 0 ? TEXT_MUTED : "#0a1a17",
              cursor: submitting || apiKey.trim().length === 0 ? "not-allowed" : "pointer",
              fontFamily: "inherit",
              transition: "background 150ms ease",
            }}
          >
            {submitting ? "Validating with Composio…" : "Connect"}
          </button>
          <div style={{ marginTop: 14, fontSize: 12, color: TEXT_DIM, lineHeight: 1.5 }}>
            Need a key?{" "}
            <a
              href="https://app.composio.dev/developers"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: MINT, textDecoration: "none" }}
            >
              Get one from Composio →
            </a>
          </div>
          <div style={{ marginTop: 18, fontSize: 11, color: TEXT_DIM, lineHeight: 1.5 }}>
            Stored locally in <code style={{ fontFamily: "ui-monospace, monospace", color: TEXT_MUTED }}>{"<repo>/.env"}</code>.
            Never leaves your machine.
          </div>
        </form>
      </div>
    </div>
  );
}

function EmptyState({ onClear }: { onClear: () => void }) {
  return (
    <div
      style={{
        textAlign: "center",
        padding: "60px 20px",
        color: TEXT_MUTED,
      }}
    >
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: 24,
          background: SURFACE_ALT,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 12,
        }}
      >
        <SearchIcon />
      </div>
      <div style={{ fontSize: 14, color: TEXT, marginBottom: 4 }}>
        No connectors match your filters
      </div>
      <div style={{ fontSize: 12, marginBottom: 14 }}>
        Try a different search term or clear filters.
      </div>
      <button
        type="button"
        onClick={onClear}
        style={{
          background: ACCENT,
          color: ACCENT_INK,
          border: "none",
          borderRadius: 4,
          padding: "6px 14px",
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        clear search
      </button>
    </div>
  );
}

// ─── Dropdown menu (Claude-style) ──────────────────────────────────────

const DropdownCloseCtx = createContext<(() => void) | null>(null);

function DropdownMenu({
  label,
  active,
  onClear,
  children,
}: {
  label: string;
  active?: boolean;
  onClear?: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const closeMenu = () => setOpen(false);

  // Close on outside click + ESC
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocDown);
    // Capture phase so we run before the modal's bubble-phase ESC handler closes it.
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div ref={rootRef} style={{ position: "relative", flexShrink: 0 }}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 14px",
          borderRadius: 10,
          background: open ? SURFACE_HOVER : SURFACE_ALT,
          border: `1px solid ${open ? BORDER_HOVER : BORDER}`,
          color: TEXT,
          fontSize: 13,
          cursor: "pointer",
          fontFamily: "inherit",
          minWidth: 130,
          justifyContent: "space-between",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {label}
          {active ? (
            <span
              aria-hidden
              title="filter active"
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                background: MINT,
                display: "inline-block",
              }}
            />
          ) : null}
        </span>
        <ChevronDownIcon />
      </button>
      {open ? (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            minWidth: 220,
            maxHeight: 380,
            overflowY: "auto",
            background: SURFACE_ALT,
            border: `1px solid ${BORDER_HOVER}`,
            borderRadius: 12,
            boxShadow: "0 12px 28px rgba(0,0,0,0.35)",
            padding: 6,
            zIndex: 10,
          }}
        >
          <DropdownCloseCtx.Provider value={closeMenu}>{children}</DropdownCloseCtx.Provider>
          {onClear ? (
            <>
              <div
                style={{
                  height: 1,
                  background: BORDER,
                  margin: "6px 4px",
                }}
              />
              <button
                type="button"
                onClick={() => {
                  onClear();
                  setOpen(false);
                }}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  background: "none",
                  border: "none",
                  color: TEXT_MUTED,
                  fontSize: 12,
                  textAlign: "left",
                  cursor: "pointer",
                  borderRadius: 6,
                  fontFamily: "inherit",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(255,255,255,0.05)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "none";
                }}
              >
                Clear filters
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DropdownGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ padding: "4px 0" }}>
      <div
        style={{
          padding: "4px 10px",
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: TEXT_DIM,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function DropdownItem({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  const closeMenu = useContext(DropdownCloseCtx);
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={() => {
        onClick();
        closeMenu?.();
      }}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        width: "100%",
        padding: "8px 10px",
        background: "none",
        border: "none",
        color: TEXT,
        fontSize: 13,
        textAlign: "left",
        cursor: "pointer",
        borderRadius: 6,
        fontFamily: "inherit",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "rgba(255,255,255,0.05)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "none";
      }}
    >
      <span>{label}</span>
      {selected ? (
        <span aria-hidden style={{ color: MINT, fontSize: 13 }}>
          ✓
        </span>
      ) : null}
    </button>
  );
}

// ─── Icons (inline SVG; zero deps) ─────────────────────────────────────

function ChevronDownIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="m6 9 6 6 6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}


function PlugIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9 2v6m6-6v6M5 8h14v3a7 7 0 1 1-14 0V8zm7 13v-3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle
        cx="11"
        cy="11"
        r="7"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="m20 20-3.5-3.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

