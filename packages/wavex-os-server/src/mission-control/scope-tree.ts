/** Mission Control — ScopeNode read-adapter.
 *
 *  Synthesizes the universal ScopeNode tree from existing on-disk data.
 *  No new persistence — all reads from existing locations:
 *
 *    Avatar mode:
 *      ~/.wavex-os/instances/default/avatars/<avatarId>/
 *        ├── profile.json              → user + avatar nodes
 *        ├── tools.json                → connected tools (per-avatar metadata)
 *        └── paperclip-handoff.json    → conductor + sub-agents
 *
 *    Solo Founder / Hybrid mode:
 *      ~/.wavex-os/instances/default/companies/<companyId>/onboarding/
 *        ├── swarm_manifest.{yaml,json} → org + departments + agents
 *        └── scope.json                  → Hybrid filter (mode + departments[])
 *
 *  Mode detection is a directory probe: presence of avatars/<id>/ means
 *  Avatar; presence of companies/<id>/onboarding/ means Solo or Hybrid;
 *  presence of scope.json with mode==='focused' means Hybrid.
 *
 *  No FK or DB lookup happens here — runners that need fresh agent status
 *  query Paperclip directly. ScopeTree is the structural skeleton; live
 *  state (capacityScore, activeTaskCount, costThisPeriodUSD) gets layered
 *  on top in Phase 1 when the activity-query API ships.
 */

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { getWavexDataRoot } from "../state-bridge.js";
import type {
  PaperclipMode,
  ScopeNode,
} from "@wavex-os/shared/types/mission-control";

// ─── Path helpers ───────────────────────────────────────────────────────

function avatarDir(avatarId: string): string {
  return join(getWavexDataRoot(), "instances", "default", "avatars", avatarId);
}

function companyOnboardingDir(companyId: string): string {
  return join(
    getWavexDataRoot(),
    "instances",
    "default",
    "companies",
    companyId,
    "onboarding",
  );
}

// ─── Mode detection ─────────────────────────────────────────────────────

export interface DetectedMode {
  mode: PaperclipMode;
  instanceId: string;
}

/** Probe disk to determine which mode this instanceId belongs to. Avatar
 *  takes precedence because avatar IDs and company IDs are theoretically
 *  disjoint, but we don't rely on that — first-match wins. Returns null
 *  when nothing on disk matches. */
export function detectMode(instanceId: string): DetectedMode | null {
  if (existsSync(avatarDir(instanceId))) {
    return { mode: "avatar", instanceId };
  }
  const onboardingPath = companyOnboardingDir(instanceId);
  if (existsSync(onboardingPath)) {
    const scopePath = join(onboardingPath, "scope.json");
    if (existsSync(scopePath)) {
      // Hybrid is Solo + focused scope. Reading scope.json content happens
      // during tree build; here we only need the mode discriminator.
      try {
        const raw = require("node:fs").readFileSync(scopePath, "utf8");
        const parsed = JSON.parse(raw) as { mode?: string };
        if (parsed.mode === "focused") return { mode: "hybrid", instanceId };
      } catch {
        // Malformed scope.json → fall through to solo_founder.
      }
    }
    return { mode: "solo_founder", instanceId };
  }
  return null;
}

// ─── Disk readers (best-effort, returns null on missing/corrupt) ────────

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

interface ProfileFile {
  name: string;
  role: string;
}
interface PaperclipHandoffFile {
  paperclipCompanyId: string;
  conductorAgentId?: string;
  agents?: Record<string, string>;
}
interface ScopeFile {
  mode: "full" | "focused";
  departments: string[];
}
interface SwarmAgentEntry {
  template_id?: string | null;
  reports_to?: string | null;
  display_name?: string;
  department?: string;
  tier?: number;
}
interface SwarmManifestShape {
  swarm_manifest?: { agents?: Record<string, SwarmAgentEntry> };
  agents?: Record<string, SwarmAgentEntry>;
}

// ─── Identity helpers ──────────────────────────────────────────────────

/** Derive an 8-char short id from a node id. UUIDs collapse to their last
 *  8 chars; slot-namespaced ids (e.g. `agent:co:cmo`) collapse to the part
 *  after the last colon. Always returns a stable, human-readable token. */
function deriveShortId(nodeId: string): string {
  if (nodeId.includes(":")) {
    const tail = nodeId.split(":").pop() ?? nodeId;
    return tail.length <= 8 ? tail : tail.slice(0, 8);
  }
  // Looks like a UUID — keep the last 8 hex chars (cleaner than first 8 + …).
  return nodeId.length <= 8 ? nodeId : nodeId.slice(-8);
}

/** Kebab-case form of a display name. Strips diacritics, lowercases,
 *  squashes anything non-alphanumeric into single hyphens, trims edges.
 *  Used as a URL-safe stable display tag. */
function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "node";
}

/** Final pass over a builder's raw output: stamps every node with
 *  `shortId` + `slug`. Builders construct nodes without those two fields
 *  for ergonomics; this guarantees the type contract before return. */
function decorateIdentity(
  partial: Omit<ScopeNode, "shortId" | "slug"> & {
    shortId?: string;
    slug?: string;
  },
): ScopeNode {
  return {
    ...partial,
    shortId: partial.shortId ?? deriveShortId(partial.id),
    slug: partial.slug ?? slugify(partial.name),
  } as ScopeNode;
}

// ─── Tree builders ──────────────────────────────────────────────────────

function emptyMetadata(): ScopeNode["metadata"] {
  return {
    activeTaskCount: 0,
    kpisOwned: [],
    costThisPeriodUSD: 0,
  };
}

async function buildAvatarTree(avatarId: string): Promise<ScopeNode[]> {
  const dir = avatarDir(avatarId);
  const profile = await readJson<ProfileFile>(join(dir, "profile.json"));
  const handoff = await readJson<PaperclipHandoffFile>(
    join(dir, "paperclip-handoff.json"),
  );

  const userId = `user:${avatarId}`;
  const avatarNodeId = `avatar:${avatarId}`;
  const conductorId = handoff?.conductorAgentId
    ? `agent:${handoff.conductorAgentId}`
    : null;

  type Partial = Omit<ScopeNode, "shortId" | "slug">;
  const nodes: Partial[] = [];

  // Root user node
  nodes.push({
    id: userId,
    kind: "user",
    name: profile?.name ?? "Operator",
    childIds: [avatarNodeId],
    metadata: emptyMetadata(),
  });

  // The avatar itself
  const avatarChildren: string[] = [];
  if (conductorId) avatarChildren.push(conductorId);
  for (const agentId of Object.values(handoff?.agents ?? {})) {
    const id = `agent:${agentId}`;
    if (id !== conductorId) avatarChildren.push(id);
  }
  nodes.push({
    id: avatarNodeId,
    kind: "avatar",
    name: profile?.name ?? avatarId,
    parentId: userId,
    childIds: avatarChildren,
    metadata: emptyMetadata(),
  });

  // Conductor (a kind of chief_of_staff — the avatar's orchestrator)
  if (conductorId) {
    nodes.push({
      id: conductorId,
      kind: "chief_of_staff",
      name: `${profile?.name ?? "Avatar"} conductor`,
      parentId: avatarNodeId,
      childIds: avatarChildren.filter((id) => id !== conductorId),
      metadata: emptyMetadata(),
    });
  }

  // Tool sub-agents
  for (const [provider, agentId] of Object.entries(handoff?.agents ?? {})) {
    const id = `agent:${agentId}`;
    if (id === conductorId) continue;
    nodes.push({
      id,
      kind: "simulated_agent",
      name: provider,
      parentId: conductorId ?? avatarNodeId,
      childIds: [],
      metadata: emptyMetadata(),
      paperclipAgentId: agentId,
    });
  }

  return nodes.map(decorateIdentity);
}

async function buildCompanyTree(
  companyId: string,
  isHybrid: boolean,
): Promise<ScopeNode[]> {
  const dir = companyOnboardingDir(companyId);
  // Manifest is typically JSON next to YAML; readers prefer JSON.
  const manifest =
    (await readJson<SwarmManifestShape>(join(dir, "company.manifest.json"))) ??
    (await readJson<SwarmManifestShape>(join(dir, "swarm_manifest.json"))) ??
    {};
  const scope = isHybrid
    ? await readJson<ScopeFile>(join(dir, "scope.json"))
    : null;

  const agents = manifest.swarm_manifest?.agents ?? manifest.agents ?? {};
  const scopedDeptSet = scope?.mode === "focused"
    ? new Set([...(scope.departments ?? []), "ceo"])
    : null;

  const userId = `user:${companyId}`;
  const orgId = `org:${companyId}`;
  const chiefId = `chief:${companyId}`;

  type Partial = Omit<ScopeNode, "shortId" | "slug">;
  const nodes: Partial[] = [];

  // Root user
  nodes.push({
    id: userId,
    kind: "user",
    name: "Operator",
    childIds: [orgId],
    metadata: emptyMetadata(),
  });

  // Org
  nodes.push({
    id: orgId,
    kind: "org",
    name: companyId,
    parentId: userId,
    childIds: [chiefId],
    metadata: emptyMetadata(),
  });

  // Chief of Staff (always present in Solo/Hybrid per spec)
  const deptNodes = new Map<string, Partial>();
  const chiefChildren: string[] = [];

  // Group agents by department
  const agentsByDept = new Map<string, string[]>();
  for (const [slot, entry] of Object.entries(agents)) {
    const dept = entry.department ?? "ops";
    if (scopedDeptSet && !scopedDeptSet.has(dept) && dept !== "ceo") {
      continue;
    }
    if (!agentsByDept.has(dept)) agentsByDept.set(dept, []);
    agentsByDept.get(dept)!.push(slot);
  }

  for (const [dept, slots] of agentsByDept) {
    const deptId = `dept:${companyId}:${dept}`;
    const childIds = slots.map((s) => `agent:${companyId}:${s}`);
    deptNodes.set(deptId, {
      id: deptId,
      kind: "department",
      name: dept,
      parentId: chiefId,
      childIds,
      metadata: emptyMetadata(),
    });
    chiefChildren.push(deptId);
  }

  nodes.push({
    id: chiefId,
    kind: "chief_of_staff",
    name: "Chief of Staff",
    parentId: orgId,
    childIds: chiefChildren,
    metadata: emptyMetadata(),
  });

  for (const dn of deptNodes.values()) nodes.push(dn);

  // Agents (leaf nodes)
  for (const [dept, slots] of agentsByDept) {
    const deptId = `dept:${companyId}:${dept}`;
    for (const slot of slots) {
      const entry = agents[slot];
      nodes.push({
        id: `agent:${companyId}:${slot}`,
        kind: "simulated_agent",
        name: entry.display_name ?? slot,
        parentId: deptId,
        childIds: [],
        metadata: emptyMetadata(),
      });
    }
  }

  return nodes.map(decorateIdentity);
}

// ─── Public API ─────────────────────────────────────────────────────────

export interface BuildScopeTreeResult {
  mode: PaperclipMode;
  instanceId: string;
  nodes: ScopeNode[];
}

/** Build the universal ScopeNode tree for an instance. Detects mode from
 *  disk, dispatches to the per-mode builder, returns the flat node list.
 *  Consumers reconstruct the tree via `parentId` / `childIds`. */
export async function buildScopeTree(
  instanceId: string,
): Promise<BuildScopeTreeResult | null> {
  const detected = detectMode(instanceId);
  if (!detected) return null;

  if (detected.mode === "avatar") {
    return {
      mode: "avatar",
      instanceId,
      nodes: await buildAvatarTree(instanceId),
    };
  }
  return {
    mode: detected.mode,
    instanceId,
    nodes: await buildCompanyTree(instanceId, detected.mode === "hybrid"),
  };
}

/** Convenience: lookup a node by ID across the result list. */
export function findNode(
  tree: BuildScopeTreeResult | null,
  nodeId: string,
): ScopeNode | null {
  if (!tree) return null;
  return tree.nodes.find((n) => n.id === nodeId) ?? null;
}

/** Convenience: list direct children. */
export function childrenOf(
  tree: BuildScopeTreeResult | null,
  nodeId: string,
): ScopeNode[] {
  if (!tree) return [];
  return tree.nodes.filter((n) => n.parentId === nodeId);
}

/** List instances on disk by scanning the wavex root. Used by the activity
 *  API to enumerate available instances for the scope dropdown. */
export async function listAllInstances(): Promise<DetectedMode[]> {
  const root = getWavexDataRoot();
  const instances: DetectedMode[] = [];
  try {
    const avatars = await readdir(join(root, "instances", "default", "avatars"));
    for (const id of avatars) instances.push({ mode: "avatar", instanceId: id });
  } catch {
    // No avatars dir yet
  }
  try {
    const companies = await readdir(
      join(root, "instances", "default", "companies"),
    );
    for (const id of companies) {
      const detected = detectMode(id);
      if (detected) instances.push(detected);
    }
  } catch {
    // No companies dir yet
  }
  return instances;
}
