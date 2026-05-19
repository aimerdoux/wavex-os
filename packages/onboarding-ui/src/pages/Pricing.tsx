/**
 * /pricing — Phase F.1 — Plan selection + Stripe Checkout redirect.
 *
 * Reads price IDs from Vite env (VITE_STRIPE_PRICE_WAVEX_OS_*) and the
 * Supabase publishable key. Auth: must be signed in to subscribe. If
 * unauthenticated, the page shows the plans but prompts sign-in before
 * checkout.
 *
 * Flow:
 *   1. User clicks Subscribe on a tier
 *   2. POST to /functions/v1/create-checkout-session with { priceId, userId }
 *   3. Function returns Stripe Checkout URL
 *   4. window.location = url
 *   5. Stripe → success_url callback → /pricing?session_id=...&tier=...
 *   6. Stripe webhook (separately) writes wavex_os.subscriptions row
 *   7. Client polls /api/subscription/status until row appears, then
 *      writes ~/.wavex-os/subscription.json via mock-core
 */
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { SignInWidget } from "../components/SignInWidget";
import { HireAgentFlow } from "../components/HireAgentFlow";
import { getSupabase } from "../lib/supabase";

type Tier = {
  key: "founder" | "growth" | "custom";
  name: string;
  priceMonthly: number;
  cadence: string;
  tokenCap: string;
  features: string[];
  envVarName: string;
  isFeatured?: boolean;
};

const TIERS: Tier[] = [
  {
    key: "founder",
    name: "Founder",
    priceMonthly: 29,
    cadence: "1 daily board-level injection",
    tokenCap: "500K Pool C tokens / month",
    features: [
      "Daily CEO context nudge",
      "All MIT code, self-host anytime",
      "14-day free trial",
    ],
    envVarName: "VITE_STRIPE_PRICE_FOUNDER",
  },
  {
    key: "growth",
    name: "Growth",
    priceMonthly: 99,
    cadence: "Hourly during business hours",
    tokenCap: "2M Pool C tokens / month",
    features: [
      "Hourly KPI watch + injection",
      "Error concierge (auto-recovery comments)",
      "Alignment correction on KPI deviation",
      "5 on-demand asks / day",
      "14-day free trial",
    ],
    envVarName: "VITE_STRIPE_PRICE_GROWTH",
    isFeatured: true,
  },
  {
    key: "custom",
    name: "Custom",
    priceMonthly: 299,
    cadence: "Continuous (5min)",
    tokenCap: "Unlimited (100 injections/day cap)",
    features: [
      "Continuous optimizer thread",
      "Human-in-the-loop concierge",
      "Unlimited on-demand asks",
      "Dedicated alignment correction",
      "14-day free trial",
    ],
    envVarName: "VITE_STRIPE_PRICE_CUSTOM",
  },
];

const CREATE_CHECKOUT_FUNCTION_URL =
  (import.meta as unknown as { env: Record<string, string> }).env
    .VITE_SUPABASE_CREATE_CHECKOUT_URL ?? "/api/billing/create-checkout-session";

function PricingCard({
  tier,
  onSubscribe,
  isPending,
}: {
  tier: Tier;
  onSubscribe: (t: Tier) => void;
  isPending: boolean;
}): JSX.Element {
  return (
    <div
      className="pricing-card"
      style={{
        background: tier.isFeatured ? "#0e1f1a" : "#0a0a0a",
        border: `1px solid ${tier.isFeatured ? "#4ec9b0" : "#1f1f23"}`,
        borderRadius: 12,
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 16,
        position: "relative",
      }}
    >
      {tier.isFeatured && (
        <div
          style={{
            position: "absolute",
            top: -10,
            right: 16,
            background: "#4ec9b0",
            color: "#0a0a0a",
            padding: "2px 10px",
            borderRadius: 4,
            fontSize: 11,
            fontFamily: "ui-monospace, JetBrains Mono, Menlo, monospace",
            letterSpacing: 0.5,
          }}
        >
          MOST POPULAR
        </div>
      )}
      <div>
        <div style={{ fontSize: 13, color: "#8a8a92", fontFamily: "ui-monospace, JetBrains Mono, Menlo, monospace" }}>
          {tier.key.toUpperCase()}
        </div>
        <div style={{ fontSize: 28, fontWeight: 600, marginTop: 4 }}>{tier.name}</div>
      </div>
      <div>
        <span style={{ fontSize: 36, fontWeight: 700 }}>${tier.priceMonthly}</span>
        <span style={{ color: "#8a8a92", marginLeft: 4 }}>/mo</span>
      </div>
      <div style={{ color: "#8a8a92", fontSize: 14, lineHeight: 1.4 }}>
        <div>{tier.cadence}</div>
        <div>{tier.tokenCap}</div>
      </div>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {tier.features.map((f) => (
          <li key={f} style={{ fontSize: 14, paddingLeft: 18, position: "relative" }}>
            <span style={{ position: "absolute", left: 0, color: "#4ec9b0" }}>✓</span>
            {f}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => onSubscribe(tier)}
        disabled={isPending}
        style={{
          marginTop: "auto",
          background: tier.isFeatured ? "#4ec9b0" : "transparent",
          color: tier.isFeatured ? "#0a0a0a" : "#e6e6e6",
          border: `1px solid ${tier.isFeatured ? "#4ec9b0" : "#1f1f23"}`,
          borderRadius: 8,
          padding: "10px 16px",
          fontSize: 14,
          fontFamily: "ui-monospace, JetBrains Mono, Menlo, monospace",
          cursor: isPending ? "wait" : "pointer",
          opacity: isPending ? 0.6 : 1,
        }}
      >
        {isPending ? "Loading…" : "Start 14-day trial"}
      </button>
    </div>
  );
}

export default function Pricing(): JSX.Element {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [pendingTier, setPendingTier] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [currentTier, setCurrentTier] = useState<"founder" | "growth" | "custom" | null>(null);

  // Look up current subscription tier so we know whether to render the
  // tier-card buy flow vs the hire-agent flow.
  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase || !session) {
      setCurrentTier(null);
      return;
    }
    void (async () => {
      // SECURITY DEFINER RPC: returns the caller's active or trialing
      // subscription via auth.uid() join. Avoids direct PostgREST
      // access to the wavex_os schema (intentionally not exposed).
      const { data } = await supabase
        .rpc("wavex_os_subscription_lookup_by_user");
      const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
      const live = row && (row.status === "trialing" || row.status === "active") ? row : null;
      setCurrentTier((live?.tier ?? null) as "founder" | "growth" | "custom" | null);
    })();
  }, [session]);

  // Called by HireAgentFlow when the operator confirms a hire.
  async function handleHireRequest(catalogId: string, requiredTier: "founder" | "growth" | "custom"): Promise<void> {
    if (!session) return;
    const supabase = getSupabase();
    if (!supabase) return;

    // If operator already has a high-enough tier, hire directly via
    // the SECURITY DEFINER RPC. The RPC verifies the subscription is
    // owned by auth.uid() AND that the customer's tier meets the
    // catalog entry's required_tier — server-side, atomically. No
    // direct PostgREST access to the wavex_os schema required.
    const tierOrder = { founder: 0, growth: 1, custom: 2 };
    if (currentTier && tierOrder[currentTier] >= tierOrder[requiredTier]) {
      const hireResult = await supabase
        .rpc("wavex_os_hire_expert", {
          p_catalog_id: catalogId,
          p_agreement_version: "1.0",
        });
      if (hireResult.error) {
        setError(`Hire failed: ${hireResult.error.message}`);
        return;
      }
      navigate("/?hired=" + encodeURIComponent(catalogId));
      return;
    }

    // Otherwise need to upgrade tier — find matching Tier card and start checkout.
    const t = TIERS.find((x) => x.key === requiredTier);
    if (t) await startCheckout(t);
  }

  // Handle success callback from Stripe Checkout
  const sessionId = params.get("session_id");
  const success = params.get("success") === "1";

  useEffect(() => {
    if (sessionId && success) {
      // Poll local mock-core (which proxies to Supabase) for subscription state.
      void pollForSubscription(sessionId).then((ok) => {
        if (ok) navigate("/?subscribed=1", { replace: true });
      });
    }
  }, [sessionId, success, navigate]);

  async function pollForSubscription(sid: string): Promise<boolean> {
    for (let i = 0; i < 30; i++) {
      try {
        const r = await fetch(`/api/billing/subscription/by-checkout/${encodeURIComponent(sid)}`);
        if (r.ok) {
          const json = (await r.json()) as { tier?: string; status?: string };
          if (json.status && json.status !== "incomplete") return true;
        }
      } catch {
        /* retry */
      }
      await new Promise((res) => setTimeout(res, 2000));
    }
    return false;
  }

  async function startCheckout(tier: Tier): Promise<void> {
    setError(null);
    if (!session) {
      setError("Please sign in first — see the box above.");
      return;
    }
    setPendingTier(tier.key);
    try {
      const priceId =
        (import.meta as unknown as { env: Record<string, string> }).env[tier.envVarName];
      if (!priceId) {
        throw new Error(
          `Price ID not configured for ${tier.key}. Run scripts/billing/setup-stripe.ts and paste output into onboarding-ui/.env`,
        );
      }

      const resp = await fetch(CREATE_CHECKOUT_FUNCTION_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          priceId,
          tier: tier.key,
          successUrl: `${window.location.origin}/pricing?session_id={CHECKOUT_SESSION_ID}&success=1`,
          cancelUrl: `${window.location.origin}/pricing?canceled=1`,
        }),
      });
      if (resp.status === 409) {
        // Already subscribed — redirect to Customer Portal
        const body = (await resp.json()) as { url: string };
        window.location.assign(body.url);
        return;
      }
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `checkout failed: HTTP ${resp.status}`);
      }
      const { url } = (await resp.json()) as { url: string };
      window.location.assign(url);
    } catch (e) {
      setError((e as Error).message);
      setPendingTier(null);
    }
  }

  return (
    <div
      style={{
        background: "#0a0a0a",
        color: "#e6e6e6",
        minHeight: "100vh",
        padding: "48px 24px",
        fontFamily: "ui-sans-serif, system-ui, -apple-system, Inter, sans-serif",
      }}
    >
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <header style={{ marginBottom: 32, textAlign: "center" }}>
          <div style={{ color: "#8a8a92", fontSize: 13, fontFamily: "ui-monospace, JetBrains Mono, Menlo, monospace", marginBottom: 8 }}>
            WAVEX OS · SYSTEM OPTIMIZER
          </div>
          <h1 style={{ fontSize: 36, fontWeight: 600, margin: 0 }}>
            Add an expert layer on top of your local fleet.
          </h1>
          <p style={{ color: "#8a8a92", fontSize: 16, lineHeight: 1.5, maxWidth: 720, margin: "16px auto 0" }}>
            The code is free, MIT. Your agents run on your machine, your Claude Max plan, your data.
            The optional optimizer subscription adds daily board-level injections, error recovery, and
            alignment correction — generated by us, paid for by us, delivered into your local Paperclip
            via a Liaison agent. Cancel anytime.
          </p>
        </header>

        <SignInWidget onSessionChange={setSession} />

        {params.get("canceled") === "1" && (
          <div
            style={{
              background: "#1f1715",
              border: "1px solid #5a3a30",
              color: "#e0a899",
              padding: "12px 16px",
              borderRadius: 8,
              marginBottom: 24,
              fontSize: 14,
            }}
          >
            Checkout canceled. You can try again any time.
          </div>
        )}
        {error && (
          <div
            style={{
              background: "#1f1515",
              border: "1px solid #5a2c2c",
              color: "#e09999",
              padding: "12px 16px",
              borderRadius: 8,
              marginBottom: 24,
              fontSize: 14,
              fontFamily: "ui-monospace, JetBrains Mono, Menlo, monospace",
            }}
          >
            {error}
          </div>
        )}

        {/* If operator already has a subscription, surface the hire-agent
            flow instead of (or above) the tier cards. */}
        {session && currentTier ? (
          <div style={{ marginBottom: 32 }}>
            <HireAgentFlow
              session={session}
              currentTier={currentTier}
              onHireRequest={handleHireRequest}
            />
          </div>
        ) : null}

        {/* Tier cards: shown to anyone without a sub, and as a "manage
            subscription" section to those with one. */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: 20,
          }}
        >
          {TIERS.map((t) => (
            <PricingCard
              key={t.key}
              tier={t}
              onSubscribe={startCheckout}
              isPending={pendingTier === t.key}
            />
          ))}
        </div>

        {/* For signed-in users without a sub, show the hire flow BELOW the
            tier cards so they see the agents they'll unlock by subscribing. */}
        {session && !currentTier ? (
          <div style={{ marginTop: 32 }}>
            <HireAgentFlow
              session={session}
              currentTier={null}
              onHireRequest={handleHireRequest}
            />
          </div>
        ) : null}

        <div
          style={{
            marginTop: 48,
            padding: 24,
            background: "#0e0e10",
            border: "1px solid #1f1f23",
            borderRadius: 12,
            fontSize: 14,
            color: "#8a8a92",
            lineHeight: 1.6,
          }}
        >
          <strong style={{ color: "#e6e6e6" }}>What is the System Optimizer?</strong>
          <p style={{ margin: "8px 0 0" }}>
            A server-side process running on api.wavex-os.com that analyzes your fleet's KPI snapshots
            and recent issues, then generates board-level direction (Founder), KPI-watching nudges + error
            recovery (Growth), or continuous alignment correction (Custom). Output is delivered to your
            local Paperclip as comments and new issues, routed through a Liaison agent your fleet hires
            automatically when you subscribe.
          </p>
          <p style={{ margin: "12px 0 0" }}>
            <strong style={{ color: "#e6e6e6" }}>Self-hostable.</strong> All optimizer code is MIT.{" "}
            <code style={{ background: "#1a1a1d", padding: "1px 6px", borderRadius: 3 }}>docs/SELF_HOSTING.md</code>{" "}
            covers how to run the optimizer on your own machine if you don't want the hosted version.
          </p>
        </div>
      </div>
    </div>
  );
}
