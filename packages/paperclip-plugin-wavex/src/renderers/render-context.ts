/** Mission Control — renderer context + helpers.
 *
 *  Renderers receive an `ActivityEvent` + this `RenderContext` and return
 *  a plain-language sentence (string). Context carries enough to resolve
 *  node IDs to display names, KPI IDs to KPI titles, etc.
 *
 *  Context is built once per Stream poll on the client side from the
 *  ScopeTree + KPI + Task lookup payloads the worker returns. Renderers
 *  must be pure: same input → same output (so snapshot tests don't flake).
 */

import type {
  ActivityEvent,
  KPI,
  PaperclipMode,
  ScopeNode,
  Task,
  Deliverable,
} from "@wavex-os/shared/types/mission-control";

export interface RenderContext {
  mode: PaperclipMode;
  scopeTree: ScopeTreeLookup;
  kpiCatalog: Map<string, KPI>;
  taskCatalog: Map<string, Task>;
  deliverableCatalog: Map<string, Deliverable>;
}

export interface ScopeTreeLookup {
  byId: Map<string, ScopeNode>;
}

export type EventRenderer = (event: ActivityEvent, ctx: RenderContext) => string;

// ─── Lookup helpers ─────────────────────────────────────────────────────

/** Derive an 8-char short id from any node id (UUID or slot-namespaced).
 *  Same algorithm as the server-side ScopeTree builder so client + server
 *  agree on what "agent_a3f2" means even when the scope tree hasn't been
 *  hydrated for this widget yet. */
export function deriveShortId(nodeId: string): string {
  if (nodeId.includes(":")) {
    const tail = nodeId.split(":").pop() ?? nodeId;
    return tail.length <= 8 ? tail : tail.slice(0, 8);
  }
  return nodeId.length <= 8 ? nodeId : nodeId.slice(-8);
}

export function nodeName(nodeId: string | undefined, ctx: RenderContext): string {
  if (!nodeId) return "Unknown";
  const node = ctx.scopeTree.byId.get(nodeId);
  if (node) return node.name;
  // Scope-tree cache miss: render the short id instead of the raw UUID so
  // the UI never leaks 36-char identifiers. The full id is still available
  // for tooltip/debug surfaces via `nodeId` directly.
  return deriveShortId(nodeId);
}

/** Returns the node's shortId, or falls back to deriving one from the id. */
export function nodeShortId(nodeId: string | undefined, ctx: RenderContext): string {
  if (!nodeId) return "—";
  const node = ctx.scopeTree.byId.get(nodeId);
  return node?.shortId ?? deriveShortId(nodeId);
}

export function kpiName(kpiId: string | undefined, ctx: RenderContext): string {
  if (!kpiId) return "(unknown KPI)";
  return ctx.kpiCatalog.get(kpiId)?.name ?? kpiId;
}

// ─── Formatting helpers ─────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}b`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}kb`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}mb`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}gb`;
}

export function formatUSD(amount: number | undefined): string {
  if (amount === undefined || amount === null) return "$0.00";
  return `$${amount.toFixed(2)}`;
}

export function formatImpact(impact: string | undefined): string | null {
  if (!impact || impact.trim().length === 0) return null;
  return impact;
}

/** Resolve who originated a task into a renderable label. Falls back to
 *  `actorNodeId` lookup when subjectRef doesn't carry richer info. */
export function resolveOriginator(
  event: ActivityEvent,
  ctx: RenderContext,
): string {
  return nodeName(event.actorNodeId, ctx);
}
