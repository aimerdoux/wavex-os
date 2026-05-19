/**
 * /lp/design-partners — Tony Apple QA Studio
 * Design partner landing page. UTM passthrough:
 * ?utm_source=outbound&utm_medium=email&utm_campaign=design-partner
 * Calendar booking link is a placeholder — CRO/OUTBOUND to supply.
 */

type ComparisonRow = { feature: string; partner: string; enterprise: string; highlight?: boolean };

const COMPARISON: ComparisonRow[] = [
  { feature: "Price", partner: "$1,000/mo", enterprise: "$1,500–$5,000/mo" },
  { feature: "iOS + Android", partner: "✓", enterprise: "✓" },
  { feature: "CI/CD native (GitHub, Bitrise, CircleCI)", partner: "✓", enterprise: "✓" },
  { feature: "Automated smoke tests", partner: "✓", enterprise: "✓" },
  { feature: "Unlimited runs", partner: "✓", enterprise: "✓" },
  { feature: "SSO", partner: "✓", enterprise: "✓" },
  { feature: "SLA", partner: "✓", enterprise: "✓" },
  { feature: "Dedicated Slack channel", partner: "✓", enterprise: "✓" },
  { feature: "Custom test suites", partner: "✓", enterprise: "✓" },
  { feature: "Co-shape the roadmap", partner: "✓ (design partner)", enterprise: "—", highlight: true },
  { feature: "Pilot pricing locked 90 days", partner: "✓ (design partner)", enterprise: "—", highlight: true },
];

const WHO_FOR = [
  "Enterprise mobile teams on iOS and/or Android",
  "Engineering or QA leads using Bitrise, Runway, or Maestro",
  "Teams spending >10% sprint time on test flakiness or CI reliability",
  "Companies shipping ≥1 app update per week",
];

const CALENDAR_HREF = "https://cal.com/wavex/design-partner";

export default function DesignPartners(): JSX.Element {
  // Preserve UTM params on all CTA clicks
  const utmSuffix =
    typeof window !== "undefined"
      ? (() => {
          const p = new URLSearchParams(window.location.search);
          const utm: string[] = [];
          for (const k of ["utm_source", "utm_medium", "utm_campaign"]) {
            const v = p.get(k);
            if (v) utm.push(`${k}=${encodeURIComponent(v)}`);
          }
          return utm.length ? `?${utm.join("&")}` : "";
        })()
      : "";

  const bookingHref = `${CALENDAR_HREF}${utmSuffix}`;

  return (
    <>
      <head>
        <title>Design Partner Program | Tony Apple QA Studio</title>
        <meta name="description" content="Join Tony Apple QA Studio's design partner program. Get a 90-day Enterprise pilot at $1,000/mo. First 3 partners only." />
        <meta property="og:title" content="Design Partner Program | Tony Apple QA Studio" />
        <meta property="og:description" content="Join Tony Apple QA Studio's design partner program. Get a 90-day Enterprise pilot at $1,000/mo. First 3 partners only." />
        <meta property="og:image" content="/og-design-partners.png" />
      </head>

      <div
        style={{
          background: "var(--bg)",
          color: "var(--text)",
          minHeight: "100vh",
          padding: "64px 24px 80px",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
        }}
      >
        <div style={{ maxWidth: 900, margin: "0 auto" }}>

          {/* Nav */}
          <nav style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 72 }}>
            <a href="/" style={{ fontWeight: 700, fontSize: 16, color: "var(--text)", textDecoration: "none" }}>
              Tony Apple QA
            </a>
            <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
              <a href="/pricing" style={{ fontSize: 14, color: "var(--text-dim)", textDecoration: "none" }}>Pricing</a>
              <a href="/lp/design-partners" style={{ fontSize: 14, color: "var(--accent)", textDecoration: "none" }}>Design Partners</a>
              <a
                href="/signup"
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  padding: "7px 16px",
                  background: "var(--accent)",
                  color: "#08221d",
                  borderRadius: 8,
                  textDecoration: "none",
                }}
              >
                Start free
              </a>
            </div>
          </nav>

          {/* Hero */}
          <header style={{ textAlign: "center", marginBottom: 48 }}>
            <div
              style={{
                display: "inline-block",
                background: "rgba(78,201,176,0.12)",
                border: "1px solid rgba(78,201,176,0.3)",
                color: "var(--accent)",
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: 0.8,
                padding: "4px 14px",
                borderRadius: 20,
                marginBottom: 20,
                fontFamily: "ui-monospace, JetBrains Mono, Menlo, monospace",
              }}
            >
              FIRST 3 PARTNERS ONLY
            </div>
            <h1 style={{ fontSize: 44, fontWeight: 700, margin: "0 0 20px", lineHeight: 1.15 }}>
              Join our design partner program
            </h1>
            <p style={{ fontSize: 18, color: "var(--text-dim)", maxWidth: 600, margin: "0 auto 32px", lineHeight: 1.6 }}>
              Get 90-day Enterprise access at founding-partner pricing — $1,000/mo
              (rack: $1,500–$5,000/mo). First 3 partners only.
            </p>

            {/* Primary CTA */}
            <a
              href={bookingHref}
              style={{
                display: "inline-block",
                padding: "14px 28px",
                background: "var(--accent)",
                color: "#08221d",
                fontWeight: 700,
                fontSize: 16,
                borderRadius: 10,
                textDecoration: "none",
                marginBottom: 16,
              }}
            >
              Book a 20-min call →
            </a>
            <div style={{ fontSize: 13, color: "var(--text-dim)" }}>
              No commitment required · 90-day pilot · Enterprise features included
            </div>
          </header>

          {/* Feature comparison table */}
          <section style={{ marginBottom: 72 }}>
            <h2 style={{ fontSize: 22, fontWeight: 700, textAlign: "center", marginBottom: 24 }}>
              What you get
            </h2>
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 14,
                }}
              >
                <thead>
                  <tr>
                    <th
                      style={{
                        textAlign: "left",
                        padding: "12px 16px",
                        borderBottom: "2px solid var(--border)",
                        fontWeight: 600,
                        color: "var(--text-dim)",
                        fontSize: 12,
                        letterSpacing: 0.5,
                        fontFamily: "ui-monospace, JetBrains Mono, Menlo, monospace",
                      }}
                    >
                      FEATURE
                    </th>
                    <th
                      style={{
                        textAlign: "center",
                        padding: "12px 16px",
                        borderBottom: "2px solid var(--accent)",
                        fontWeight: 700,
                        color: "var(--accent)",
                        fontSize: 13,
                        background: "rgba(78,201,176,0.06)",
                      }}
                    >
                      Design Partner (90-day pilot)
                    </th>
                    <th
                      style={{
                        textAlign: "center",
                        padding: "12px 16px",
                        borderBottom: "2px solid var(--border)",
                        fontWeight: 600,
                        color: "var(--text-dim)",
                        fontSize: 13,
                      }}
                    >
                      Regular Enterprise
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {COMPARISON.map((row, i) => (
                    <tr
                      key={i}
                      style={{
                        background: row.highlight
                          ? "rgba(78,201,176,0.05)"
                          : i % 2 === 0
                          ? "transparent"
                          : "rgba(255,255,255,0.015)",
                      }}
                    >
                      <td
                        style={{
                          padding: "12px 16px",
                          borderBottom: "1px solid var(--border)",
                          fontWeight: row.highlight ? 600 : 400,
                          color: row.highlight ? "var(--accent)" : "var(--text)",
                        }}
                      >
                        {row.feature}
                      </td>
                      <td
                        style={{
                          padding: "12px 16px",
                          borderBottom: "1px solid var(--border)",
                          textAlign: "center",
                          color: row.highlight ? "var(--accent)" : "var(--text)",
                          fontWeight: row.highlight ? 600 : 400,
                          background: "rgba(78,201,176,0.04)",
                        }}
                      >
                        {row.partner}
                      </td>
                      <td
                        style={{
                          padding: "12px 16px",
                          borderBottom: "1px solid var(--border)",
                          textAlign: "center",
                          color: row.enterprise === "—" ? "var(--text-dim)" : "var(--text)",
                        }}
                      >
                        {row.enterprise}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Why design partners */}
          <section
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: "32px 36px",
              marginBottom: 56,
            }}
          >
            <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>Why design partners</h2>
            <p style={{ fontSize: 15, color: "var(--text-dim)", lineHeight: 1.7, margin: 0 }}>
              We're selectively partnering with 3 enterprise mobile teams who want to co-define what
              great automated QA looks like. You get enterprise-grade infrastructure at a fraction of
              the cost. We get real-world signal from teams shipping to millions of users. This is not
              a discount — it's a founding relationship.
            </p>
          </section>

          {/* Who this is for */}
          <section style={{ marginBottom: 72 }}>
            <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 20 }}>Who this is for</h2>
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 12 }}>
              {WHO_FOR.map((item, i) => (
                <li key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start", fontSize: 15 }}>
                  <span style={{ color: "var(--accent)", marginTop: 2, flexShrink: 0 }}>→</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>

          {/* Secondary CTA */}
          <section
            style={{
              background: "#0e1f1a",
              border: "1px solid rgba(78,201,176,0.3)",
              borderRadius: 12,
              padding: "40px 36px",
              textAlign: "center",
              marginBottom: 72,
            }}
          >
            <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 16 }}>
              Ready to stop firefighting flaky tests?
            </h2>
            <p style={{ fontSize: 14, color: "var(--text-dim)", marginBottom: 28 }}>
              Spots are limited — we're onboarding a maximum of 3 design partners.
            </p>
            <a
              href={bookingHref}
              style={{
                display: "inline-block",
                padding: "14px 28px",
                background: "var(--accent)",
                color: "#08221d",
                fontWeight: 700,
                fontSize: 16,
                borderRadius: 10,
                textDecoration: "none",
              }}
            >
              Schedule a 20-min call →
            </a>
          </section>

          {/* Footer */}
          <footer
            style={{
              paddingTop: 32,
              borderTop: "1px solid var(--border)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: 13,
              color: "var(--text-dim)",
              flexWrap: "wrap",
              gap: 12,
            }}
          >
            <span>
              Pricing shown for design partner program only. Enterprise rack pricing starts at
              $1,500/mo. Contact us for details.
            </span>
            <div style={{ display: "flex", gap: 20 }}>
              <a href="/pricing" style={{ color: "var(--text-dim)", textDecoration: "none" }}>Pricing</a>
              <a href="mailto:hello@tonyappleqa.com" style={{ color: "var(--text-dim)", textDecoration: "none" }}>Contact</a>
            </div>
          </footer>
        </div>
      </div>
    </>
  );
}
