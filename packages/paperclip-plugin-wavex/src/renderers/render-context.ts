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

export function nodeName(nodeId: string | undefined, ctx: RenderContext): string {
  if (!nodeId) return "Unknown";
  const node = ctx.scopeTree.byId.get(nodeId);
  if (!node) return nodeId; // fall back to ID so unknowns don't silently disappear
  // Mode-aware: in Solo Founder, a chief node is "Chief of Staff"; in Avatar,
  // an avatar node is "Sales Avatar" etc. Renderers can compose ${nodeName(...)}
  // without worrying about kind.
  return node.name;
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
