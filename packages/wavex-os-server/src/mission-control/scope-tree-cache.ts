/** TTL-based in-memory cache for ScopeTree results.
 *
 *  Tree synthesis touches disk on every call; for stream consumers that
 *  resolve node names per-event, that's an unacceptable cost. Cache
 *  keyed by instanceId with a 5-minute TTL. Explicit invalidation
 *  exposed for callers that emit `node_added` / `node_archived` events
 *  (Phase 1.6 hook sites).
 *
 *  Scope: per-process. Single dev instance assumed; horizontal-scale
 *  invalidation lands when we have multi-instance prod (out of scope
 *  for Phase 0).
 */

import { buildScopeTree, type BuildScopeTreeResult } from "./scope-tree.js";

interface CacheEntry {
  tree: BuildScopeTreeResult | null;
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

export async function getScopeTreeCached(
  instanceId: string,
): Promise<BuildScopeTreeResult | null> {
  const hit = cache.get(instanceId);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.tree;
  }
  const tree = await buildScopeTree(instanceId);
  cache.set(instanceId, { tree, expiresAt: Date.now() + TTL_MS });
  return tree;
}

/** Drop the cached tree for an instance. Call when a node is added /
 *  archived / status-mutated. Cheap, idempotent. */
export function invalidateScopeTree(instanceId: string): void {
  cache.delete(instanceId);
}

/** Drop everything. Test helper + ops escape hatch. */
export function invalidateAllScopeTrees(): void {
  cache.clear();
}

/** Pure diagnostic: how many trees are in cache + their TTLs. */
export function debugCacheState(): Array<{
  instanceId: string;
  expiresAt: number;
  expiresInMs: number;
}> {
  const now = Date.now();
  return Array.from(cache.entries()).map(([instanceId, entry]) => ({
    instanceId,
    expiresAt: entry.expiresAt,
    expiresInMs: entry.expiresAt - now,
  }));
}
