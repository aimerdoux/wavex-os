# @wavex-os/inference-server

Mac-hosted Fastify proxy for the two WaveX-paid inference pools:

- **Pool A** — anonymous, rate-limited onboarding T2 enrichment (wizard's Pillar 1 inference, Monte Carlo, decision matrices)
- **Pool C** — JWT-gated optimizer inference (System Optimizer subscriptions: Founder/Growth/Custom)

Pool B (the customer's own Claude Max for their local fleet) does NOT go through here — it stays on the customer's Mac via the existing OAuth wrapper.

## Topology

```
Customer Mac (anywhere) → HTTPS → api.wavex-os.com (Cloudflare DNS)
   → Cloudflare Tunnel (cloudflared) → 127.0.0.1:8787 (this Fastify)
   → Anthropic SDK (operator's Max 20× OAuth from macOS Keychain)
   → Supabase (subscription state + usage ledger)
```

Full architecture rationale: see [`docs/V2_CAPTURE_C_inference_server.md`](../../docs/V2_CAPTURE_C_inference_server.md).

## Phase status

- **G.3 (this commit):** scaffold — routes return 503 stubs so the surrounding plumbing (wizard, Liaison agent) can be exercised against real endpoints. The actual Anthropic calls + rate limit + ledger writes land in **G.3.b** (next sprint).
- **G.3.b:** wire Pool A with real JWT issuance + Redis rate limit + Anthropic streaming + ledger writes.
- **F.4:** wire Pool C alongside the Liaison agent.

## Local dev

```bash
cd packages/inference-server
pnpm install
pnpm dev    # tsx watch, binds 127.0.0.1:8787
curl http://127.0.0.1:8787/v1/health
```

## Production install (Mac, via launchd)

1. Build: `pnpm build` in this dir.
2. Install Redis: `brew install redis && brew services start redis`.
3. Install cloudflared: `brew install cloudflared`.
4. Create a Cloudflare Tunnel: `cloudflared tunnel login && cloudflared tunnel create wavex-os-inference`.
5. Configure the tunnel to point at `127.0.0.1:8787` via `~/.wavex-os/state/cloudflared.yml`:

   ```yaml
   tunnel: <tunnel-uuid>
   credentials-file: /Users/<you>/.cloudflared/<tunnel-uuid>.json
   ingress:
     - hostname: api.wavex-os.com
       service: http://127.0.0.1:8787
     - service: http_status:404
   ```

6. Route DNS: `cloudflared tunnel route dns wavex-os-inference api.wavex-os.com`.
7. Render the two launchd plists from templates:

   ```bash
   WAVEX_OS_ROOT="$HOME/wavex-os" \
   STATE_DIR="$HOME/.wavex-os/state" \
     pnpm tuning:map  # if your render script registered the new templates
   ```

   Or manually:

   ```bash
   sed -e "s|\${WAVEX_OS_ROOT}|$HOME/wavex-os|g" \
       -e "s|\${STATE_DIR}|$HOME/.wavex-os/state|g" \
       templates/launchd/com.wavex-os.inference-server.plist.tmpl \
       > ~/Library/LaunchAgents/com.wavex-os.inference-server.plist

   sed -e "s|\${STATE_DIR}|$HOME/.wavex-os/state|g" \
       templates/launchd/com.wavex-os.cloudflared.plist.tmpl \
       > ~/Library/LaunchAgents/com.wavex-os.cloudflared.plist
   ```

8. Load both:

   ```bash
   launchctl load -w ~/Library/LaunchAgents/com.wavex-os.inference-server.plist
   launchctl load -w ~/Library/LaunchAgents/com.wavex-os.cloudflared.plist
   ```

9. Verify: `curl https://api.wavex-os.com/v1/health` should return JSON.

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `WAVEX_INFERENCE_PORT` | `8787` | Fastify bind port |
| `WAVEX_INFERENCE_HOST` | `127.0.0.1` | Always bind loopback. Cloudflared exposes externally. |
| `WAVEX_INFERENCE_ADMIN_TOKEN` | unset | Required by `/admin/*` routes. Set via `launchctl setenv` from your Keychain. |
| `SUPABASE_URL` | unset | Required by G.3.b onward |
| `SUPABASE_SERVICE_ROLE_KEY` | unset | Required by G.3.b onward |
| `ANTHROPIC_API_KEY` | unset | Required by G.3.b. Fallback for OAuth-blocked cases. |
| `INFERENCE_BACKEND` | `oauth` | `oauth` uses Keychain OAuth; `apikey` uses ANTHROPIC_API_KEY. |
| `WAVEX_OS_STREAMING_INFERENCE_ENABLED` | unset | `1` enables Pool B relay. Omit to keep observe-and-reject mode. |
| `WAVEX_OS_POOL_B_PROVIDER_MODE` | `anthropic_only` | `anthropic_only`, `anthropic_then_codex`, or `codex_only` for prompt-based Pool B coverage. |
| `WAVEX_OS_POOL_B_OPENAI_MODEL` | `gpt-5` | OpenAI model used when the Codex/OpenAI fallback path is active. |
| `OPENAI_API_KEY` | unset | Required when `WAVEX_OS_POOL_B_PROVIDER_MODE` uses the Codex/OpenAI fallback path. |
| `WAVEX_OS_POOL_B_OPENAI_INPUT_USD_PER_1M` | unset | Optional pricing override for OpenAI fallback cost accounting. |
| `WAVEX_OS_POOL_B_OPENAI_OUTPUT_USD_PER_1M` | unset | Optional pricing override for OpenAI fallback cost accounting. |
| `REDIS_URL` | `redis://localhost:6379` | Rate limit + idempotency store |

## Endpoints

| Method | Path | Pool | Status |
|---|---|---|---|
| GET | `/v1/health` | n/a | ✅ live |
| POST | `/v1/onboarding/session` | A | stub (G.3.b) |
| POST | `/v1/onboarding/t2` | A | 503 stub (G.3.b) |
| GET | `/v1/optimizer/queue/:sub_id` | C | 503 stub (F.4) |
| POST | `/v1/optimizer/generate` | C | 503 stub (F.5) |
| POST | `/admin/freeze` | n/a | stub (G.3.b) — needs `x-admin-token` header |
| POST | `/admin/unfreeze` | n/a | stub (G.3.b) |
| GET | `/admin/status` | n/a | stub (G.3.b) |
| GET | `/admin/pool-b/requests?limit=100` | n/a | recent Supabase-backed Pool B forensic audit rows |

## TOS note (V2_CAPTURE_C §3 + §8)

Anthropic's Max subscription Acceptable Use section on reselling is ambiguous about backend service use. Before customer #1 in production:

1. Read the current TOS section "Acceptable Use — Reselling".
2. Decide whether to ship with `INFERENCE_BACKEND=oauth` (Max-served) or `apikey` (metered API).
3. The fallback flip is a single env var — no code change needed.
