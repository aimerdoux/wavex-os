# Deploy notes — schema-exposure fix (2026-05-19)

## What broke

Live customer onboarding (foodexinc.com) hit:
```
Failed to save draft: The schema must be one of the following: public, graphql_public, meta_ads
```

The `wavex_os` schema is intentionally NOT in PostgREST's `db.schemas` exposure list. 8 callsites (6 browser, 2 server) were trying to `.schema("wavex_os").from(...)` directly. PostgREST refused → "Failed to save draft" surfaces to the user.

## What shipped (`502d5a09` on `main`)

5 new SECURITY DEFINER RPCs in `public.*`, all filtered by `auth.uid()` inside the function body:

| RPC | Replaces |
|---|---|
| `wavex_os_list_active_catalog()` | `HireAgentFlow` reading `expert_agent_catalog` |
| `wavex_os_my_digest_access_log(p_limit int)` | `PrivacyPanel` reading `digest_access_log` |
| `wavex_os_revoke_hire(p_hire_id uuid)` | `PrivacyPanel` updating `hired_expert_agents.status` |
| `wavex_os_hire_expert(p_catalog_id text, p_agreement_version text)` | `Pricing` 2-step lookup + insert (now atomic) |
| `wavex_os_my_active_hires_for_envelopes()` | `wavex-liaison/encrypt-envelopes.mjs` join read |

Plus inference-server's `usage_ledger` insert now uses the existing `wavex_os_record_usage` RPC instead of `.schema("wavex_os").from("usage_ledger").insert()`.

Build verified: new `dist/assets/index-Dn8SiH-g.js` has **0** direct schema calls + **6** `wavex_os_*` RPC calls.

## Manual deploy steps (operator-side)

### 1. Apply the migration to Supabase

Either:

**A. Via Supabase CLI (preferred):**
```bash
cd /Users/geniex/wavex-os
supabase login   # if not already
supabase link --project-ref ngvtgraldybxdbgkihfj
supabase db push
```

**B. Via Dashboard SQL Editor:**
1. Open https://supabase.com/dashboard/project/ngvtgraldybxdbgkihfj/sql
2. Paste the contents of `supabase/migrations/20260519000001_wavex_os_client_rpcs.sql`
3. Run

Verify with:
```sql
select proname from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in (
    'wavex_os_list_active_catalog',
    'wavex_os_my_digest_access_log',
    'wavex_os_revoke_hire',
    'wavex_os_hire_expert',
    'wavex_os_my_active_hires_for_envelopes'
  );
```
Should return 5 rows.

### 2. Redeploy the onboarding-ui

**If wavexcard.com is being promoted from this repo's `packages/onboarding-ui`:**
- Sync the deploy from `main` (commit `502d5a09` or later).
- Build artifact: `packages/onboarding-ui/dist/assets/index-Dn8SiH-g.js`.

**If Lovable serves the wizard from a separate codebase:**
- Paste the 5 RPC migrations into the Lovable project's Supabase (same project_ref — they share the DB).
- In the Lovable code, replace any `.schema("wavex_os").from(table)` with the equivalent `.rpc("wavex_os_*")` call. Mapping is in the table above.
- The Lovable Supabase client signature for an RPC is:
  ```ts
  const { data, error } = await supabase.rpc("wavex_os_list_active_catalog");
  // or with args:
  await supabase.rpc("wavex_os_revoke_hire", { p_hire_id: hireId });
  ```

### 3. Verify live

After deploy, the foodexinc.com flow should:
1. Land on the 3-card gateway (Avatar / Solo Founder / Hybrid).
2. Click any → URL prompt.
3. Type `https://www.foodexinc.com` → Enter.
4. Narrator says "Got it. Reading your site…" — Pillar 1 fires.
5. Wizard advances to Pillar 2 without the "Failed to save draft" error.

## What was NOT touched

- `scripts/qa/seed-test-customer.mjs` (4 callsites) — operator-only QA seeder, uses SERVICE_ROLE_KEY. Doesn't run in production browser. Follow-up if seeder fails post-deploy.
- `scripts/expert-agents/upload-public-key.mjs` (1 callsite) — operator-only key-upload script, same reason.

## Followups (lower priority)

- Audit RLS on `wavex_os.subscriptions` to ensure customers can only read their own row even if a future change accidentally exposes `wavex_os` via `db.schemas`. Defense-in-depth — the new RPCs already enforce caller-ownership, but RLS is the second layer.
- Long-term, replace the 5 service-role-only `wavex_os_record_*` server RPCs with the same pattern (filtered by `auth.uid()` instead of `service_role`) so the inference-server can stop carrying the service key on customer machines.
