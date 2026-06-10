/**
 * Inline sign-in widget for /pricing.
 *
 * Email-magic-link auth via Supabase. After the user enters their email
 * and clicks "Send magic link", Supabase emails them. They click the
 * link, get redirected back to /pricing with a session in the URL fragment,
 * Supabase JS auto-picks it up, and the widget collapses to a "signed in
 * as X" line. Then the Subscribe buttons enable.
 *
 * Why magic link and not password: password flows have a "forgot password"
 * branch + minimum 8 chars + visible password field etc. Magic link is
 * one input and works on mobile. For B2B-style operator users it's the
 * right default.
 */
import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { getSupabase, isSupabaseConfigured } from "../lib/supabase";

export interface SignInWidgetProps {
  /** Called when sign-in state changes — pricing page uses this to gate Subscribe buttons. */
  onSessionChange: (session: Session | null) => void;
  /** URL to redirect the user to after clicking the magic link.
   *  Defaults to the /pricing page. Override for flows like /signup where
   *  UTM params must be preserved across the magic-link round-trip. */
  redirectTo?: string;
  /** Override the "Sign in to …" label shown when the user is not signed in. */
  signInLabel?: string;
}

export function SignInWidget({ onSessionChange, redirectTo, signInLabel = "Sign in to subscribe" }: SignInWidgetProps): JSX.Element {
  const supabase = getSupabase();
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      onSessionChange(data.session);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      onSessionChange(s);
    });
    return () => sub.subscription.unsubscribe();
  }, [supabase, onSessionChange]);

  if (!isSupabaseConfigured()) {
    return (
      <div style={card("#3a2a1a", "#6a4a30")}>
        <strong style={{ color: "#e6b88a" }}>Auth not configured.</strong>
        <p style={{ color: "#8a8a92", fontSize: 14, margin: "8px 0 0" }}>
          Pricing requires Supabase. Set <code>VITE_SUPABASE_URL</code> +{" "}
          <code>VITE_SUPABASE_ANON_KEY</code> in <code>packages/onboarding-ui/.env</code> and reload.
        </p>
      </div>
    );
  }

  if (session) {
    return (
      <div style={card("#0e1f1a", "#2a6b5e")}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div>
            <strong style={{ color: "#4ec9b0" }}>Signed in</strong>
            <span style={{ color: "#8a8a92", marginLeft: 8, fontSize: 14 }}>
              as {session.user.email}
            </span>
          </div>
          <button
            type="button"
            onClick={() => { void supabase!.auth.signOut(); }}
            style={ghostButton}
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  async function sendLink(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!supabase) return;
    setError(null);
    setSending(true);
    const { error: err } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo ?? `${window.location.origin}/pricing` },
    });
    setSending(false);
    if (err) {
      setError(err.message);
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <div style={card("#0e1f1a", "#2a6b5e")}>
        <strong style={{ color: "#4ec9b0" }}>Check your email.</strong>
        <p style={{ color: "#8a8a92", fontSize: 14, margin: "8px 0 0" }}>
          We sent a magic link to <strong style={{ color: "#e6e6e6" }}>{email}</strong>. Click it to sign in and return here.
        </p>
        <button
          type="button"
          onClick={() => { setSent(false); setEmail(""); }}
          style={{ ...ghostButton, marginTop: 12 }}
        >
          Use a different email
        </button>
      </div>
    );
  }

  return (
    <div style={card("#0e0e10", "#1f1f23")}>
      <div style={{ marginBottom: 12 }}>
        <strong style={{ color: "#e6e6e6" }}>{signInLabel}</strong>
        <p style={{ color: "#8a8a92", fontSize: 13, margin: "4px 0 0" }}>
          We'll email you a one-tap sign-in link. No password.
        </p>
      </div>
      <form onSubmit={sendLink} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          style={input}
        />
        <button type="submit" disabled={sending || !email} style={primaryButton(sending || !email)}>
          {sending ? "Sending…" : "Send magic link"}
        </button>
      </form>
      {error && (
        <div style={{ color: "#e09999", marginTop: 8, fontSize: 13, fontFamily: "ui-monospace, monospace" }}>
          {error}
        </div>
      )}
    </div>
  );
}

// ─── styles ────────────────────────────────────────────────────────────
function card(bg: string, border: string): React.CSSProperties {
  return {
    background: bg,
    border: `1px solid ${border}`,
    borderRadius: 8,
    padding: 16,
    marginBottom: 24,
  };
}
const input: React.CSSProperties = {
  flex: 1,
  minWidth: 200,
  background: "#0a0a0a",
  color: "#e6e6e6",
  border: "1px solid #1f1f23",
  borderRadius: 6,
  padding: "9px 12px",
  fontSize: 14,
  fontFamily: "ui-sans-serif, system-ui",
};
const primaryButton = (disabled: boolean): React.CSSProperties => ({
  background: disabled ? "#1f1f23" : "#4ec9b0",
  color: disabled ? "#666" : "#0a0a0a",
  border: "none",
  borderRadius: 6,
  padding: "9px 16px",
  fontSize: 14,
  fontFamily: "ui-monospace, monospace",
  cursor: disabled ? "not-allowed" : "pointer",
  opacity: disabled ? 0.6 : 1,
});
const ghostButton: React.CSSProperties = {
  background: "transparent",
  color: "#8a8a92",
  border: "1px solid #1f1f23",
  borderRadius: 6,
  padding: "6px 12px",
  fontSize: 13,
  fontFamily: "ui-monospace, monospace",
  cursor: "pointer",
};
