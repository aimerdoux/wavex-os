/**
 * /book — Experience selector + Stripe Checkout redirect (WAV-71)
 *
 * Flow:
 *   1. User browses static experience catalog
 *   2. Selects an experience (requires sign-in)
 *   3. POST /api/booking/intent → booking_intent_id
 *   4. POST /functions/v1/create-booking-checkout-session → Stripe URL
 *   5. window.location = Stripe checkout URL
 *   6. On return (?session_id=...&success=1) show confirmation
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { SignInWidget } from "../components/SignInWidget";
import { getSupabase } from "../lib/supabase";

type Experience = {
  id: string;
  name: string;
  description: string;
  price_cents: number;
  currency: string;
  badge?: string;
};

const EXPERIENCES: Experience[] = [
  {
    id: "yacht-charter-miami",
    name: "Miami Yacht Charter",
    description: "Private 50ft yacht, Biscayne Bay. Crew + provisioning included. Half-day (4 h).",
    price_cents: 250000,
    currency: "usd",
    badge: "POPULAR",
  },
  {
    id: "f1-paddock-miami",
    name: "F1 Miami Paddock Experience",
    description: "Paddock Club access, pit lane walk, driver Q&A. Race weekend (Fri–Sun).",
    price_cents: 600000,
    currency: "usd",
  },
  {
    id: "art-basel-vip",
    name: "Art Basel VIP Preview",
    description: "Opening-night vernissage + gallery access for 2. Champagne + private tour.",
    price_cents: 120000,
    currency: "usd",
    badge: "LIMITED",
  },
  {
    id: "boat-show-vip",
    name: "Miami Boat Show VIP Package",
    description: "Private broker tour of superyachts, hosted lunch, sea trial arranged on request.",
    price_cents: 80000,
    currency: "usd",
  },
  {
    id: "sunset-helicopter",
    name: "Miami Sunset Helicopter",
    description: "Private 30-min helicopter tour at golden hour. Up to 3 guests.",
    price_cents: 150000,
    currency: "usd",
  },
];

const ENV = (import.meta as unknown as { env: Record<string, string> }).env;

function supabaseFunctionUrl(path: string): string {
  const base = ENV.VITE_SUPABASE_URL ?? "";
  return `${base}/functions/v1/${path}`;
}

function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
  }).format(cents / 100);
}

function ExperienceCard({
  exp,
  onSelect,
  isPending,
}: {
  exp: Experience;
  onSelect: (e: Experience) => void;
  isPending: boolean;
}): JSX.Element {
  return (
    <div
      style={{
        background: "#0a0a0a",
        border: "1px solid #1f1f23",
        borderRadius: 12,
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        position: "relative",
      }}
    >
      {exp.badge && (
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
          {exp.badge}
        </div>
      )}
      <div>
        <div style={{ fontSize: 13, color: "#8a8a92", fontFamily: "ui-monospace, monospace", marginBottom: 4 }}>
          {exp.id.toUpperCase()}
        </div>
        <div style={{ fontSize: 20, fontWeight: 600 }}>{exp.name}</div>
      </div>
      <div style={{ color: "#8a8a92", fontSize: 14, lineHeight: 1.5 }}>{exp.description}</div>
      <div style={{ fontSize: 28, fontWeight: 700, marginTop: "auto" }}>
        {formatPrice(exp.price_cents, exp.currency)}
      </div>
      <button
        type="button"
        onClick={() => onSelect(exp)}
        disabled={isPending}
        style={{
          background: isPending ? "#1f1f23" : "#4ec9b0",
          color: isPending ? "#666" : "#0a0a0a",
          border: "none",
          borderRadius: 8,
          padding: "10px 16px",
          fontSize: 14,
          fontFamily: "ui-monospace, JetBrains Mono, Menlo, monospace",
          cursor: isPending ? "wait" : "pointer",
          opacity: isPending ? 0.6 : 1,
        }}
      >
        {isPending ? "Preparing…" : "Book now"}
      </button>
    </div>
  );
}

export default function Booking(): JSX.Element {
  const [params] = useSearchParams();
  const [session, setSession] = useState<Session | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sessionId = params.get("session_id");
  const success = params.get("success") === "1";
  const canceled = params.get("canceled") === "1";

  useEffect(() => {
    // Ensure Supabase picks up the session from the URL fragment on return.
    const sb = getSupabase();
    if (!sb) return;
    void sb.auth.getSession();
  }, []);

  async function handleSelect(exp: Experience): Promise<void> {
    if (!session) {
      setError("Please sign in first — see the box above.");
      return;
    }
    setError(null);
    setPendingId(exp.id);

    try {
      // Step 1: create booking_intent
      const intentResp = await fetch("/api/booking/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          experience_id: exp.id,
          experience_name: exp.name,
          experience_price_cents: exp.price_cents,
          currency: exp.currency,
        }),
      });
      if (!intentResp.ok) {
        const body = await intentResp.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `booking/intent failed: HTTP ${intentResp.status}`);
      }
      const { booking_intent_id } = (await intentResp.json()) as { booking_intent_id: string };

      // Step 2: create Stripe Checkout session
      const checkoutResp = await fetch(supabaseFunctionUrl("create-booking-checkout-session"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          booking_intent_id,
          success_url: `${window.location.origin}/book?success=1`,
          cancel_url: `${window.location.origin}/book?canceled=1`,
        }),
      });
      if (!checkoutResp.ok) {
        const body = await checkoutResp.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `checkout session failed: HTTP ${checkoutResp.status}`);
      }
      const { url } = (await checkoutResp.json()) as { url: string };
      window.location.assign(url);
    } catch (e) {
      setError((e as Error).message);
      setPendingId(null);
    }
  }

  if (success && sessionId) {
    return (
      <div style={pageStyle}>
        <div style={{ maxWidth: 600, margin: "0 auto", textAlign: "center", paddingTop: 80 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>✓</div>
          <h1 style={{ fontSize: 28, fontWeight: 600, margin: "0 0 12px" }}>Booking confirmed</h1>
          <p style={{ color: "#8a8a92", fontSize: 16, lineHeight: 1.5 }}>
            Your payment was received. You'll get a confirmation email shortly with experience
            details and next steps.
          </p>
          <a
            href="/"
            style={{
              display: "inline-block",
              marginTop: 32,
              background: "#4ec9b0",
              color: "#0a0a0a",
              padding: "10px 24px",
              borderRadius: 8,
              textDecoration: "none",
              fontFamily: "ui-monospace, monospace",
              fontSize: 14,
            }}
          >
            Back to home
          </a>
        </div>
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <header style={{ marginBottom: 32, textAlign: "center" }}>
          <div style={{ color: "#8a8a92", fontSize: 13, fontFamily: "ui-monospace, monospace", marginBottom: 8 }}>
            WAVEX · EXPERIENCES
          </div>
          <h1 style={{ fontSize: 36, fontWeight: 600, margin: 0 }}>Book an Experience</h1>
          <p style={{ color: "#8a8a92", fontSize: 16, lineHeight: 1.5, maxWidth: 600, margin: "16px auto 0" }}>
            Curated luxury experiences. Select one below to reserve your spot.
          </p>
        </header>

        <SignInWidget
          onSessionChange={setSession}
          redirectTo={`${typeof window !== "undefined" ? window.location.origin : ""}/book`}
          signInLabel="Sign in to book"
        />

        {canceled && (
          <div style={banner("#1f1715", "#5a3a30", "#e0a899")}>
            Checkout canceled. You can try again any time.
          </div>
        )}
        {error && (
          <div style={banner("#1f1515", "#5a2c2c", "#e09999")}>
            {error}
          </div>
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: 20,
          }}
        >
          {EXPERIENCES.map((exp) => (
            <ExperienceCard
              key={exp.id}
              exp={exp}
              onSelect={handleSelect}
              isPending={pendingId === exp.id}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── styles ────────────────────────────────────────────────────────────
const pageStyle: React.CSSProperties = {
  background: "#0a0a0a",
  color: "#e6e6e6",
  minHeight: "100vh",
  padding: "48px 24px",
  fontFamily: "ui-sans-serif, system-ui, -apple-system, Inter, sans-serif",
};

function banner(bg: string, border: string, color: string): React.CSSProperties {
  return {
    background: bg,
    border: `1px solid ${border}`,
    color,
    padding: "12px 16px",
    borderRadius: 8,
    marginBottom: 24,
    fontSize: 14,
  };
}
