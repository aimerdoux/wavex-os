/** Mission Control sidebar entry.
 *
 *  Renders a single nav link at the top of Paperclip's sidebar, navigating
 *  to the full-page Mission Control view at /<companyPrefix>/mission-control.
 *  Without this entry the page route has no in-app entry point.
 */

import type { PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";

const ACCENT = "#4ec9b0";
const BORDER = "rgba(255,255,255,0.08)";

export function MissionControlSidebarEntry({ context }: PluginSidebarProps) {
  const companyPrefix = context.companyPrefix ?? "";
  const href = companyPrefix ? `/${companyPrefix}/mission-control` : "#";
  const disabled = !companyPrefix;

  const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (disabled) {
      e.preventDefault();
      return;
    }
    // Use SPA push so we don't reload — falls back to default link otherwise.
    if (typeof window !== "undefined" && window.history?.pushState) {
      e.preventDefault();
      window.history.pushState({}, "", href);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  };

  return (
    <a
      href={href}
      onClick={onClick}
      aria-disabled={disabled}
      aria-label="Open Mission Control"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        padding: "8px 12px",
        borderRadius: 4,
        border: `1px solid ${BORDER}`,
        background: "transparent",
        color: "inherit",
        textDecoration: "none",
        cursor: disabled ? "not-allowed" : "pointer",
        fontSize: 13,
        fontWeight: 500,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <RadarIcon />
      <span>Mission Control</span>
    </a>
  );
}

function RadarIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx={12} cy={12} r={9} />
      <circle cx={12} cy={12} r={5} />
      <circle cx={12} cy={12} r={1.5} fill={ACCENT} />
      <path d="M12 3 L12 12 L19 8" />
    </svg>
  );
}
