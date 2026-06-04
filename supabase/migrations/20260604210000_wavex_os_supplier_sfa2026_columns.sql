-- SFA 2026 follow-up worker columns (WAVAAAAAA-205)
--
-- followUpWorker.ts resolves matched suppliers and needs profile_url and
-- categories to personalise the 48h post-show email. The existing
-- company_name column covers the "name" lookup; status covers "verified".
--
-- Safe to run multiple times (ADD COLUMN IF NOT EXISTS).

ALTER TABLE public.suppliers
  ADD COLUMN IF NOT EXISTS profile_url text,
  ADD COLUMN IF NOT EXISTS categories  text[];
