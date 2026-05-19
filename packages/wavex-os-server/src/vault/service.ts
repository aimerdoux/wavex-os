/** Credential vault service. Wraps the encrypted writes/reads + audit log
 *  against @wavex-os/db credentials + credential_audit_log tables.
 *
 *  Status semantics (per CONNECTOR — collected across all keys for that
 *  connector):
 *    - vaulted_valid       : >=1 key vaulted AND lastTestedAt is recent + ok
 *    - vaulted_unvalidated : >=1 key vaulted but never tested (or test failed)
 *    - skipped             : explicit skip recorded with reason
 *    - pending             : neither vaulted nor skipped */

import { randomUUID, createHash } from "node:crypto";
import { eq, and, desc } from "drizzle-orm";
import { getDb, runMigrations, credentials, credentialAuditLog } from "@wavex-os/db";
import { encrypt, decrypt, infoFor } from "./crypto.js";

let migrated = false;
async function ensureMigrated(): Promise<void> {
  if (migrated) return;
  await runMigrations();
  migrated = true;
}

/** Test-only — reset the migration latch so a fresh DB triggers re-migration. */
export function _resetMigrationLatch(): void {
  migrated = false;
}

export type CredentialStatus = "vaulted_valid" | "vaulted_unvalidated" | "skipped" | "pending";

export interface ConnectorCredentialState {
  connectorId: string;
  status: CredentialStatus;
  vaultedKeys: string[];
  lastTestedAt: string | null;
  lastTestResult: { ok: boolean; detail?: string } | null;
  skipReason: string | null;
}

export interface CredentialMetadata {
  /** Result of the most recent test, persisted in `metadata` jsonb. */
  lastTestedAt?: string;
  lastTestOk?: boolean;
  lastTestDetail?: string;
  /** When status === "skipped". */
  skipReason?: string;
  /** Source of the credential — paste / oauth / pillar5_inline. */
  writtenBy?: string;
}

export async function writeCredential(params: {
  companyId: string;
  connectorId: string;
  key: string;
  plaintext: string;
  writtenBy?: string;
}): Promise<{ id: string; vaultedAt: string }> {
  await ensureMigrated();
  const db = await getDb();
  const enc = encrypt(params.plaintext, infoFor(params.companyId, params.connectorId, params.key));
  const id = `cr_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

  // Soft-rotate: if a row already exists for (company, connector, key), insert
  // a new row and tag it as the current via metadata. We keep the old for audit.
  await db.insert(credentials).values({
    id,
    companyId: params.companyId,
    connectorId: params.connectorId,
    key: params.key,
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    authTag: enc.authTag,
    salt: enc.salt,
    metadata: { writtenBy: params.writtenBy ?? "paste" } as CredentialMetadata,
  });
  await db.insert(credentialAuditLog).values({
    id: `cal_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    companyId: params.companyId,
    connectorId: params.connectorId,
    action: "write",
    actorAgentId: null,
    metadata: {
      key: params.key,
      writtenBy: params.writtenBy ?? "paste",
      hashHint: createHash("sha256").update(params.plaintext).digest("hex").slice(0, 8),
    },
  });
  return { id, vaultedAt: new Date().toISOString() };
}

export async function readCredential(params: {
  companyId: string;
  connectorId: string;
  key: string;
}): Promise<string | null> {
  await ensureMigrated();
  const db = await getDb();
  const rows = await db.select().from(credentials).where(and(
    eq(credentials.companyId, params.companyId),
    eq(credentials.connectorId, params.connectorId),
    eq(credentials.key, params.key),
  )).orderBy(desc(credentials.createdAt)).limit(1);
  if (rows.length === 0) return null;
  const r = rows[0];
  return decrypt(
    { ciphertext: r.ciphertext, iv: r.iv, authTag: r.authTag, salt: r.salt },
    infoFor(params.companyId, params.connectorId, params.key),
  );
}

export async function recordTestResult(params: {
  companyId: string;
  connectorId: string;
  key: string;
  ok: boolean;
  detail?: string;
}): Promise<void> {
  await ensureMigrated();
  const db = await getDb();
  // Append-only test record in audit log + keyed for the specific (connector, key).
  await db.insert(credentialAuditLog).values({
    id: `cal_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    companyId: params.companyId,
    connectorId: params.connectorId,
    action: params.ok ? "test_ok" : "test_fail",
    actorAgentId: null,
    metadata: { key: params.key, detail: params.detail },
  });
}

export async function skipConnector(params: {
  companyId: string;
  connectorId: string;
  reason: string;
}): Promise<void> {
  await ensureMigrated();
  const db = await getDb();
  await db.insert(credentialAuditLog).values({
    id: `cal_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    companyId: params.companyId,
    connectorId: params.connectorId,
    action: "skip",
    actorAgentId: null,
    metadata: { reason: params.reason },
  });
}

/** Hard-delete every credential row for one connector + audit it. Used
 *  by the Mission Control connectors directory's disconnect action. The
 *  audit row stays even after the credentials are gone so listConnector-
 *  States can still surface the historical skip/disconnect signal. */
export async function deleteAllForConnector(params: {
  companyId: string;
  connectorId: string;
  actorAgentId?: string | null;
}): Promise<{ removed: number }> {
  await ensureMigrated();
  const db = await getDb();
  const existing = await db
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.companyId, params.companyId),
        eq(credentials.connectorId, params.connectorId),
      ),
    );
  if (existing.length === 0) return { removed: 0 };
  await db
    .delete(credentials)
    .where(
      and(
        eq(credentials.companyId, params.companyId),
        eq(credentials.connectorId, params.connectorId),
      ),
    );
  await db.insert(credentialAuditLog).values({
    id: `cal_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    companyId: params.companyId,
    connectorId: params.connectorId,
    action: "delete",
    actorAgentId: params.actorAgentId ?? null,
    metadata: { removedKeys: existing.map((r) => r.key) },
  });
  return { removed: existing.length };
}

export async function listConnectorStates(companyId: string): Promise<Map<string, ConnectorCredentialState>> {
  await ensureMigrated();
  const db = await getDb();

  const credRows = await db.select().from(credentials).where(eq(credentials.companyId, companyId));
  const auditRows = await db.select().from(credentialAuditLog)
    .where(eq(credentialAuditLog.companyId, companyId))
    .orderBy(desc(credentialAuditLog.occurredAt));

  const byConnector = new Map<string, ConnectorCredentialState>();

  // Bucket credentials by connector
  for (const r of credRows) {
    let s = byConnector.get(r.connectorId);
    if (!s) {
      s = {
        connectorId: r.connectorId,
        status: "vaulted_unvalidated",
        vaultedKeys: [],
        lastTestedAt: null,
        lastTestResult: null,
        skipReason: null,
      };
      byConnector.set(r.connectorId, s);
    }
    if (!s.vaultedKeys.includes(r.key)) s.vaultedKeys.push(r.key);
  }

  // Apply audit log in chronological order (oldest first → newest wins)
  // (we queried desc, so iterate in reverse)
  for (const e of auditRows.reverse()) {
    let s = byConnector.get(e.connectorId);
    if (!s) {
      // Skip-only connector (no credentials ever written)
      s = {
        connectorId: e.connectorId,
        status: "pending",
        vaultedKeys: [],
        lastTestedAt: null,
        lastTestResult: null,
        skipReason: null,
      };
      byConnector.set(e.connectorId, s);
    }
    const m = (e.metadata ?? {}) as CredentialMetadata & { detail?: string; reason?: string };
    if (e.action === "test_ok") {
      s.lastTestedAt = e.occurredAt.toISOString();
      s.lastTestResult = { ok: true, detail: m.detail };
      if (s.vaultedKeys.length > 0) s.status = "vaulted_valid";
    } else if (e.action === "test_fail") {
      s.lastTestedAt = e.occurredAt.toISOString();
      s.lastTestResult = { ok: false, detail: m.detail };
      if (s.vaultedKeys.length > 0) s.status = "vaulted_unvalidated";
    } else if (e.action === "skip") {
      s.status = "skipped";
      s.skipReason = m.reason ?? null;
    } else if (e.action === "write") {
      // Writing after a skip un-skips
      if (s.status === "skipped") s.status = "vaulted_unvalidated";
    }
  }

  return byConnector;
}
