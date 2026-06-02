/** Hardcoded featured-toolkit list. In live mode this can be augmented or
 *  swapped for a Composio API call. The shim returns this verbatim so the
 *  Phase 2 connector picker UI has options to render even in disabled
 *  mode — the operator picks toolkits, gets a "configure later" message,
 *  and Phase 2 generation still produces a complete connector manifest. */
import type { FeaturedToolkit } from "./types.js";

// Logos use Google's favicon service (full-color, visible on dark tiles,
// zero-maintenance). The UI's <img> onError falls back to a monogram, so a
// missing icon degrades gracefully. Live Composio mode overrides these.
const ICON = (domain: string) =>
  `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;

export const FEATURED_TOOLKITS: ReadonlyArray<FeaturedToolkit> = [
  { slug: "slack", displayName: "Slack", category: "comms", logo: ICON("slack.com") },
  { slug: "telegram", displayName: "Telegram", category: "comms", logo: ICON("telegram.org") },
  { slug: "discord", displayName: "Discord", category: "comms", logo: ICON("discord.com") },
  { slug: "gmail", displayName: "Gmail", category: "comms", logo: ICON("gmail.com") },
  { slug: "outlook", displayName: "Outlook", category: "comms", logo: ICON("outlook.com") },
  { slug: "hubspot", displayName: "HubSpot", category: "crm", logo: ICON("hubspot.com") },
  { slug: "salesforce", displayName: "Salesforce", category: "crm", logo: ICON("salesforce.com") },
  { slug: "stripe", displayName: "Stripe", category: "billing", logo: ICON("stripe.com") },
  { slug: "mixpanel", displayName: "Mixpanel", category: "analytics", logo: ICON("mixpanel.com") },
  { slug: "amplitude", displayName: "Amplitude", category: "analytics", logo: ICON("amplitude.com") },
  { slug: "github", displayName: "GitHub", category: "dev", logo: ICON("github.com") },
  { slug: "linear", displayName: "Linear", category: "dev", logo: ICON("linear.app") },
  { slug: "notion", displayName: "Notion", category: "ops", logo: ICON("notion.so") },
  { slug: "google_calendar", displayName: "Google Calendar", category: "ops", logo: ICON("calendar.google.com") },
  { slug: "microsoft_calendar", displayName: "Microsoft Calendar", category: "ops", logo: ICON("outlook.com") },
  { slug: "google_drive", displayName: "Google Drive", category: "ops", logo: ICON("drive.google.com") },
];
