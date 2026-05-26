/** Chat-first onboarding shell — replaces the multi-page wizard with a
 *  single-screen conversation. Reuses the existing T2 inference pipeline
 *  end-to-end; what changes is orchestration. Earned full-screen reveals
 *  (Swarm Studio, Imprint Theater) take over only at the moments that
 *  warrant them; everything else stays inline in the chat. */

import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { wavexOsOnboardingApi, ApiError } from "../lib/api";
import { useCompany, slugifyCompanyId } from "../lib/CompanyContext";
import { isT0FastMode } from "../lib/dev-flags";
import { TokenCounter } from "../components/TokenCounter";
import { BudgetChip } from "../components/BudgetChip";
import { T2ProgressIndicator } from "../components/T2ProgressIndicator";
import { HelpChat } from "../components/HelpChat";
import { Pillar1ConfirmCard } from "../components/inline-cards/Pillar1ConfirmCard";
import { Pillar1HaltCard } from "../components/inline-cards/Pillar1HaltCard";
import { Pillar3PromptCard } from "../components/inline-cards/Pillar3PromptCard";
import { Pillar4PromptCard } from "../components/inline-cards/Pillar4PromptCard";
import { Pillar5PromptCard } from "../components/inline-cards/Pillar5PromptCard";
import { ConnectorPickerCard } from "../components/inline-cards/ConnectorPickerCard";
import { ScopePromptCard } from "../components/inline-cards/ScopePromptCard";
import { AccountTypeSelectCard } from "../components/inline-cards/AccountTypeSelectCard";
import { AvatarProfileCard } from "../components/inline-cards/AvatarProfileCard";
import { AvatarToolsCard } from "../components/inline-cards/AvatarToolsCard";
import { AvatarVoiceCard } from "../components/inline-cards/AvatarVoiceCard";
import { AvatarTrustCard } from "../components/inline-cards/AvatarTrustCard";
import { AvatarSuggestionsCard } from "../components/inline-cards/AvatarSuggestionsCard";
import { CredentialDrawer } from "../components/CredentialDrawer";
import { SystemHealthChip } from "../components/SystemHealthChip";
import { detectScope, type Department } from "../lib/scope-detect";
import { SwarmStudio } from "./SwarmStudio";
import { ImprintTheater } from "./ImprintTheater";
import { ActivateProgress } from "./ActivateProgress";
import { Pricing } from "../pricing/Pricing";
import { reducer, initialState, phaseProgressPct, type AccountType, type AvatarAutomationSuggestion, type AvatarProfile, type AvatarProfilePrefill, type AvatarToolConnection, type AvatarTrust, type AvatarVoiceProfile, type ChatMessage, type ChatSlot, type OnboardingPhase } from "../state/onboarding-reducer";
import type { ConnectorManifest, Pillar1Response, Pillar3Response, Pillar4Response, Pillar5Response, SwarmManifest } from "@wavex-os/plugin-onboarding";

/** Heuristic: does the typed input look like a URL or a hostname?
 *  If yes we'll use the hostname as the slug seed; otherwise first 3 words. */
function deriveSlug(rawInput: string): string {
  const trimmed = rawInput.trim();
  const urlMatch = trimmed.match(/(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i);
  if (urlMatch) {
    const host = urlMatch[1].replace(/^www\./i, "");
    const labels = host.split(".");
    return slugifyCompanyId(labels[0]);
  }
  const words = trimmed.split(/\s+/).slice(0, 3).join(" ");
  return slugifyCompanyId(words || "company");
}

/** The WaveX OS brand wordmark. Two-tone: "Wave" in the foreground text
 *  color, "X" in the accent with a subtle drop-shadow glow, "OS" trailing
 *  in a smaller weight. An accent dot pulses softly to the left so the
 *  brand has a living signature in the corner without dominating the
 *  screen. `size="hero"` doubles the type for the welcome screen; the
 *  default `compact` is the size used in the TopBar after onboarding
 *  starts. */
function Wordmark({ size = "compact" }: { size?: "hero" | "compact" }) {
  const isHero = size === "hero";
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: isHero ? "0.6rem" : "0.45rem" }}>
      <style>{`
        @keyframes wavex-brand-pulse {
          0%, 100% { opacity: 0.5; transform: scale(0.95); }
          50%      { opacity: 1;   transform: scale(1.1);  }
        }
      `}</style>
      <span
        aria-hidden
        style={{
          width: isHero ? 9 : 6,
          height: isHero ? 9 : 6,
          borderRadius: "50%",
          background: "var(--accent)",
          boxShadow: `0 0 ${isHero ? 12 : 8}px var(--accent)`,
          animation: "wavex-brand-pulse 2.4s ease-in-out infinite",
        }}
      />
      <span style={{
        fontWeight: 700,
        fontSize: isHero ? 22 : 13,
        letterSpacing: isHero ? "-0.01em" : "0.02em",
        color: "var(--text)",
        display: "inline-flex",
        alignItems: "baseline",
        gap: 0,
      }}>
        <span>Wave</span>
        <span style={{
          color: "var(--accent)",
          textShadow: "0 0 12px color-mix(in srgb, var(--accent) 45%, transparent)",
        }}>X</span>
        <span style={{
          marginLeft: isHero ? "0.5rem" : "0.35rem",
          color: "var(--text-dim)",
          fontWeight: 500,
          fontSize: isHero ? 14 : 11,
          letterSpacing: "0.12em",
          alignSelf: "center",
        }}>OS</span>
      </span>
    </div>
  );
}

/** Does the welcome input contain a URL-shaped token? Used to decide
 *  whether to send it to Pillar 1 as `raw_input` (the server will fetch
 *  and read the site) or treat it as a self-described pitch (manual_context,
 *  no URL fetch). Without this gate, typing something like "we build AI
 *  agents" trips a halt screen because the server tries to fetch it as
 *  a URL and fails. */
function inputLooksLikeUrl(text: string): boolean {
  return /(?:https?:\/\/)?[a-z0-9-]+\.[a-z]{2,}/i.test(text);
}

/** Minimum chars required by Pillar 1's manual_context validator. Mirrors
 *  the server-side schema; doing the check on the client lets us nudge the
 *  operator for more detail before submitting (better UX than a 400). */
const MANUAL_CONTEXT_MIN_CHARS = 40;

function onboardingPhaseTitle(phase: OnboardingPhase): string {
  switch (phase.kind) {
    case "pillars": {
      const labels: Record<1 | 2 | 3 | 4 | 5, string> = {
        1: "Pillar 1: Who you are",
        2: "Pillar 2: Setup verification",
        3: "Pillar 3: Product state",
        4: "Pillar 4: GTM motion",
        5: "Pillar 5: Comms",
      };
      return `WaveX OS — ${labels[phase.stage]}`;
    }
    case "connectors":
    case "credentials":
      return "WaveX OS — Phase 2: Connectors";
    case "swarm_transition":
    case "swarm_studio":
      return "WaveX OS — Phase 3: Swarm";
    case "imprint_theater":
    case "pricing":
      return "WaveX OS — Finalize";
    case "activate":
      return "WaveX OS — Activate";
    case "account_type_select":
    case "welcome":
      return "WaveX OS — Onboarding";
    case "avatar_welcome":
    case "avatar_profile":
    case "avatar_tools":
    case "avatar_voice":
    case "avatar_trust":
    case "avatar_suggestions":
      return "WaveX OS — Avatar setup";
    default:
      return "WaveX OS";
  }
}

// ── Chat session localStorage persistence ────────────────────────────────────
// Keyed by companyId so different companies don't clobber each other.
// Version prefix lets us silently discard stale serialization formats.
const CHAT_STORAGE_KEY = (id: string) => `wavex-os-chat-v1:${id}`;

function loadChatSession(companyId: string): Pick<import("../state/onboarding-reducer").OnboardingState, "thread" | "phase" | "draft"> | null {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY(companyId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.thread)) return null;
    // Drop in-flight thinking bubbles — they had no response attached.
    const thread = parsed.thread.filter((m: import("../state/onboarding-reducer").ChatMessage) => m.slot?.kind !== "thinking");
    return { thread, phase: parsed.phase ?? initialState.phase, draft: parsed.draft ?? {} };
  } catch { return null; }
}

function saveChatSession(companyId: string, state: import("../state/onboarding-reducer").OnboardingState): void {
  try {
    localStorage.setItem(CHAT_STORAGE_KEY(companyId), JSON.stringify({
      thread: state.thread.filter((m) => m.slot?.kind !== "thinking"),
      phase: state.phase,
      draft: state.draft,
    }));
  } catch { /* quota exceeded — ignore */ }
}

function clearChatSession(companyId: string): void {
  try { localStorage.removeItem(CHAT_STORAGE_KEY(companyId)); } catch { /* ignore */ }
}

export function OnboardingShell() {
  const { companyId, setCompanyId } = useCompany();
  const qc = useQueryClient();
  // Lazy initializer: if ?companyId= is in the URL on first load, restore the
  // persisted chat session from localStorage so a page refresh doesn't wipe
  // the conversation. When localStorage has data, thread.length > 0 prevents
  // the server-resume breadcrumb path from running (see seededRef effect).
  const [state, dispatch] = useReducer(reducer, initialState, (s) => {
    const storedId = new URLSearchParams(window.location.search).get("companyId");
    if (!storedId) return s;
    return { ...s, ...(loadChatSession(storedId) ?? {}) };
  });
  const t0 = isT0FastMode();

  useEffect(() => {
    document.title = onboardingPhaseTitle(state.phase);
    return () => {
      document.title = "WaveX OS";
    };
  }, [state.phase]);

  // ── First mount: resume path ────────────────────────────────────────────
  // Fresh state shows an EmptyState hero. When companyId is present in the
  // URL, walk every persisted artifact (pillar responses, scope, manifests)
  // and emit a collapsed breadcrumb per completed step, then transition the
  // phase to whatever's next. Operators get a sense of "I'm picking up at
  // the right place" instead of a wall of nothing.
  const seededRef = useRef(false);
  // Buffers a short non-URL welcome message while we wait for the operator
  // to expand it. When their next message arrives, we concatenate before
  // submitting so their first attempt isn't lost.
  const pendingPitchRef = useRef<string | null>(null);
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    // No companyId in URL = fresh visit. Show the account-type gateway
    // instead of dropping straight into the welcome textarea so operators
    // pick their track first. Operators with an avatarId param (handled
    // by a sibling Avatar resume effect) also bypass this.
    if (!companyId && state.thread.length === 0 && state.phase.kind === "welcome") {
      dispatch({ type: "SET_PHASE", phase: { kind: "account_type_select" } });
      return;
    }
    if (!companyId || state.thread.length > 0) return;

    void (async () => {
      try {
        const [status, scopeRes, connectorRes, swarmRes] = await Promise.all([
          wavexOsOnboardingApi.status(companyId).catch(() => null),
          wavexOsOnboardingApi.getScope(companyId).catch(() => null),
          wavexOsOnboardingApi.loadConnector(companyId).catch(() => null),
          wavexOsOnboardingApi.loadSwarm(companyId).catch(() => null),
        ]);

        if (!status) {
          dispatch({
            type: "ADD_MESSAGE",
            message: { role: "assistant", text: `Welcome back to ${companyId}. Couldn't load prior state.` },
          });
          return;
        }

        const r = status.responses;
        dispatch({
          type: "ADD_MESSAGE",
          message: { role: "assistant", text: `Welcome back to ${companyId}. Here's what we had.` },
        });

        // Breadcrumb per completed step. Each lands as a collapsed ✓
        // summary so the operator can scan their prior answers.
        const breadcrumbs: string[] = [];
        if (r?.pillar_1) {
          breadcrumbs.push(`Pillar 1: ${r.pillar_1.industry_hint ?? "industry"} · ${r.pillar_1.business_model_hint ?? "model"} · ${r.pillar_1.has_product ? "live" : "pre-product"}`);
        }
        if (r?.pillar_2) breadcrumbs.push(`Pillar 2: Claude ${r.pillar_2.claude_plan}`);
        if (scopeRes?.scope) {
          const s = scopeRes.scope;
          breadcrumbs.push(s.mode === "focused"
            ? `Scope: ${s.departments.join(" + ") || "custom only"}`
            : "Scope: full org");
        }
        if (r?.pillar_3) breadcrumbs.push(`Pillar 3: ${r.pillar_3.product_state} · ${r.pillar_3.stage}`);
        if (r?.pillar_4) breadcrumbs.push(`Pillar 4: ${r.pillar_4.sales_motion} via ${r.pillar_4.lead_sources?.join(", ")}`);
        if (r?.pillar_5) breadcrumbs.push(`Pillar 5: ${r.pillar_5.comm_channel}`);
        if (connectorRes?.exists) breadcrumbs.push(`Connectors picked`);
        if (swarmRes?.exists) breadcrumbs.push(`Swarm assembled (${Object.keys(swarmRes.manifest?.agents ?? {}).length} agents)`);

        for (const text of breadcrumbs) {
          dispatch({
            type: "ADD_MESSAGE",
            message: { role: "assistant", text: `✓ ${text}`, collapsed: true },
          });
        }

        // Figure out what's next based on what's missing. status.next_pillar
        // is the authoritative answer for pillars 1-5; after that we walk
        // through scope → connector → credentials → swarm → studio → theater.
        if (status.next_pillar) {
          if (status.next_pillar === 1) {
            // No Pillar 1 — let them type in the hero. Already in welcome state.
            return;
          }
          // Pillar 1 done; need to pick up at one of 2-5. The cleanest re-entry
          // is to re-fire from the appropriate prompt.
          const stage = status.next_pillar;
          dispatch({ type: "SET_PHASE", phase: { kind: "pillars", stage, thinking: stage === 2 } });
          if (stage === 3) {
            dispatch({
              type: "ADD_MESSAGE",
              message: { role: "assistant", text: "Where are you in the product journey?", slot: { kind: "pillar3-prompt" } },
            });
          } else if (stage === 4) {
            dispatch({
              type: "ADD_MESSAGE",
              message: { role: "assistant", text: "How do leads come in?", slot: { kind: "pillar4-prompt" } },
            });
          } else if (stage === 5) {
            dispatch({
              type: "ADD_MESSAGE",
              message: { role: "assistant", text: "How do you want your board to talk to you?", slot: { kind: "pillar5-prompt" } },
            });
          }
          // stage 2 thinking re-fires the silent verify effect on mount
          return;
        }

        // All pillars done — figure out where in the post-pillar pipeline.
        if (!scopeRes?.scope) {
          // Need scope. Show scope-prompt with whatever Pillar 1 detected.
          const detected = r?.pillar_1?.industry_hint ? detectScope(r.pillar_1.industry_hint) : [];
          dispatch({
            type: "ADD_MESSAGE",
            message: {
              role: "assistant",
              text: "Pick up: tell me how to scope your team.",
              slot: { kind: "scope-prompt", detected },
            },
          });
          return;
        }
        if (!connectorRes?.exists) {
          dispatch({ type: "SET_PHASE", phase: { kind: "connectors", loading: true } });
          return;
        }
        if (!swarmRes?.exists) {
          // Connectors picked but no swarm yet — re-open credentials drawer.
          dispatch({ type: "SET_PHASE", phase: { kind: "credentials", drawerOpen: true } });
          return;
        }
        // Swarm exists — back into Studio so the operator can review + launch.
        dispatch({ type: "SET_PHASE", phase: { kind: "swarm_studio", manifest: swarmRes.manifest! } });
      } catch (e) {
        dispatch({
          type: "ADD_MESSAGE",
          message: { role: "assistant", text: `Welcome back to ${companyId}. Hydration failed: ${e instanceof Error ? e.message : String(e)}` },
        });
      }
    })();
  }, [companyId, state.thread.length]);

  // Persist chat state to localStorage whenever it changes (company sessions only).
  useEffect(() => {
    if (!companyId || state.thread.length === 0) return;
    saveChatSession(companyId, state);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, state.thread, state.phase, state.draft]);

  // Clear the persisted session on successful wizard completion or avatar finalization.
  useEffect(() => {
    if (!companyId) return;
    if (state.phase.kind === "handed_off" || state.phase.kind === "avatar_done") {
      clearChatSession(companyId);
    }
  }, [companyId, state.phase.kind]);

  const showEmptyState =
    state.thread.length === 0
    && (state.phase.kind === "welcome"
        || state.phase.kind === "account_type_select"
        || state.phase.kind === "avatar_welcome");
  const showAccountTypeGateway = state.phase.kind === "account_type_select";
  const showAvatarWelcome = state.phase.kind === "avatar_welcome";
  const handleAccountTypeSelected = useCallback((accountType: AccountType) => {
    dispatch({ type: "ACCOUNT_TYPE_SELECTED", accountType });
  }, []);

  /** Run Pillar 1 inference end-to-end. Emits a thinking bubble, awaits the
   *  T2 call, then emits either an inline confirm card (success) or an
   *  inline halt card (409). Reused by both welcome submit and halt-resume. */
  const runPillar1 = useCallback(async (
    slug: string,
    rawInput: string,
    manualContext?: string,
  ): Promise<void> => {
    const thinkingId = `thinking-${Date.now().toString(36)}`;
    dispatch({
      type: "ADD_MESSAGE",
      message: {
        id: thinkingId,
        role: "assistant",
        text: manualContext
          ? "Working with what you described…"
          : "Got it — reading your site. This usually takes 60–90 seconds.",
        slot: { kind: "thinking", phase: "pillar-1" },
      },
    });
    // Fast-mode (?t0=1) short-circuits Pillar 1's T2 enrichment by passing
    // the raw input as manual_context. Real T2 enrichment is gated on the
    // operator NOT being in fast mode.
    const effectiveManualContext = manualContext
      ?? (t0 && rawInput.trim().length >= 40
        ? rawInput
        : t0
          ? `${rawInput} (fast-mode placeholder context; switch off ?t0=1 for real enrichment).`
          : undefined);

    try {
      const result = await wavexOsOnboardingApi.pillar1({
        companyId: slug,
        org_name: slug,
        raw_input: rawInput,
        manual_context: effectiveManualContext,
      });
      dispatch({ type: "COLLAPSE_MESSAGE", id: thinkingId });
      dispatch({ type: "PILLAR1_RESPONSE", response: result.response });
      dispatch({
        type: "ADD_MESSAGE",
        message: {
          role: "assistant",
          text: "Here's what I inferred — adjust if anything's off.",
          slot: { kind: "pillar1-confirm", response: result.response },
        },
      });
      qc.invalidateQueries({ queryKey: ["status", slug] });
    } catch (e) {
      dispatch({ type: "COLLAPSE_MESSAGE", id: thinkingId });
      if (e instanceof ApiError && e.halt) {
        dispatch({ type: "PILLAR1_HALT", operatorMessage: e.halt.operator_message });
        dispatch({
          type: "ADD_MESSAGE",
          message: {
            role: "assistant",
            text: e.halt.operator_message,
            slot: { kind: "pillar1-halt", operatorMessage: e.halt.operator_message },
          },
        });
      } else {
        dispatch({
          type: "ADD_MESSAGE",
          message: {
            role: "assistant",
            text: `That didn't go through: ${e instanceof Error ? e.message : String(e)}`,
          },
        });
      }
    }
  }, [qc, t0]);

  // ── Welcome → company slug + Pillar 1 ───────────────────────────────────
  /** Phase 5 — Avatar welcome-hero handler. The operator types a free-text
   *  intro; T2 parses it into the four profile fields and the
   *  AvatarProfileCard lands inline pre-filled. Falls back to an empty
   *  prefill on parse error so the card still renders. */
  const handleAvatarWelcomeSubmit = useCallback(async (rawIntro: string) => {
    dispatch({ type: "ADD_MESSAGE", message: { role: "user", text: rawIntro } });
    dispatch({
      type: "ADD_MESSAGE",
      message: {
        role: "assistant",
        text: "Reading your intro…",
        slot: { kind: "transition-pill", label: "Reading your intro…" },
      },
    });
    let profile: AvatarProfilePrefill = {};
    try {
      const r = await wavexOsOnboardingApi.parseAvatarIntro(rawIntro, isT0FastMode());
      profile = r.profile;
    } catch { /* empty profile — card still renders for manual fill */ }
    dispatch({ type: "COLLAPSE_LAST_SLOT", kind: "transition-pill" });
    dispatch({ type: "AVATAR_PROFILE_PREFILLED", profile });
    dispatch({
      type: "ADD_MESSAGE",
      message: {
        role: "assistant",
        text: "Got it. Here's what I caught — adjust anything off.",
        slot: { kind: "avatar-profile" },
      },
    });
  }, []);

  const handleSubmit = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (state.phase.kind === "avatar_welcome") {
      await handleAvatarWelcomeSubmit(trimmed);
      return;
    }

    if (state.phase.kind === "welcome") {
      const hasUrl = inputLooksLikeUrl(trimmed);
      dispatch({ type: "ADD_MESSAGE", message: { role: "user", text: trimmed } });

      // Non-URL path: accumulate pitch fragments until we have enough for
      // a useful T2 call. Each new submission appends to the buffer (with
      // " — " separator) so the operator's earlier attempts are never
      // dropped. URL inputs short-circuit this and submit straight through.
      const accumulated = !hasUrl && pendingPitchRef.current
        ? `${pendingPitchRef.current} — ${trimmed}`
        : trimmed;

      if (!hasUrl && accumulated.length < MANUAL_CONTEXT_MIN_CHARS) {
        dispatch({
          type: "ADD_MESSAGE",
          message: {
            role: "assistant",
            text: "Got it — tell me a bit more so I can sketch the right team. What do you build, who buys it, and where are you in the journey? (Even one or two sentences works.)",
          },
        });
        pendingPitchRef.current = accumulated;
        return;
      }

      // Have enough now (URL or accumulated pitch). Clear buffer and submit.
      const slug = deriveSlug(accumulated);
      pendingPitchRef.current = null;
      dispatch({ type: "WELCOME_SUBMIT", rawInput: accumulated });
      setCompanyId(slug);

      if (hasUrl) {
        // URL path: server fetches the site, no manual_context needed.
        await runPillar1(slug, accumulated);
      } else {
        // Pitch path: skip URL fetch entirely by passing the input as
        // manual_context and raw_input="no product yet" (the upstream
        // convention for pre-product / self-described entries).
        await runPillar1(slug, "no product yet", accumulated);
      }
      return;
    }

    // Default: just echo. Subsequent phase handlers wire actual work.
    dispatch({ type: "ADD_MESSAGE", message: { role: "user", text: trimmed } });
  }, [state.phase, setCompanyId, runPillar1, handleAvatarWelcomeSubmit]);

  /** Drop a transient "moving to next step" pill in the chat between a
   *  card-submit and the next card's mount, then run `next` after a 400ms
   *  beat so the operator's eye registers the advance. The pill collapses
   *  to a ✓ breadcrumb when the next message lands. */
  const transitionWithPill = useCallback((label: string, next: () => void): void => {
    dispatch({
      type: "ADD_MESSAGE",
      message: { role: "assistant", text: label, slot: { kind: "transition-pill", label } },
    });
    window.setTimeout(() => {
      dispatch({ type: "COLLAPSE_LAST_SLOT", kind: "transition-pill" });
      next();
    }, 400);
  }, []);

  /** Inference-grounded narrator: fires /wavex-os/onboarding/narrate with
   *  the current pillar context and returns ONE tailored transition
   *  sentence ("Got the picture — 40 paying customers and $50K MRR.
   *  Now let me figure out which connectors you actually need.")
   *
   *  Races against a 2s deadline — if the call hasn't returned by then we
   *  return the hardcoded fallback so the chat NEVER stalls. The narrator
   *  call piggybacks on the 400ms transition-pill animation so most of the
   *  visible latency disappears anyway. */
  const narrateOrFallback = useCallback(async (
    from: string,
    to: string,
    fallback: string,
  ): Promise<string> => {
    const slug = companyId ?? deriveSlug(state.draft.pillar1?.rawInput ?? "");
    if (!slug) return fallback;
    const NARRATOR_TIMEOUT_MS = 2000;
    try {
      const result = await Promise.race([
        wavexOsOnboardingApi.narrate({ companyId: slug, from, to }).then((r) => r.sentence || fallback),
        new Promise<string>((resolve) => setTimeout(() => resolve(fallback), NARRATOR_TIMEOUT_MS)),
      ]);
      return result || fallback;
    } catch {
      return fallback;
    }
  }, [companyId, state.draft.pillar1?.rawInput]);

  /** Pillar 1 halt-recovery handler — passed into Pillar1HaltCard via the
   *  slot context. The card calls this with the operator's free-text. */
  const handlePillar1Recovery = useCallback((response: Pillar1Response) => {
    dispatch({ type: "PILLAR1_RESPONSE", response });
    dispatch({
      type: "ADD_MESSAGE",
      message: {
        role: "assistant",
        text: "Got it. Here's what I'll work with — adjust if anything's off.",
        slot: { kind: "pillar1-confirm", response },
      },
    });
  }, []);

  /** Pillar 2 silent verify — fires when stage transitions to 2/thinking.
   *  Default claude_plan=max_20x (dev demo path). Surfaces a verify-fail
   *  slot only if the probe reports an installation/auth issue. On success
   *  emits the scope picker (which routes to Pillar 3 on confirm). */
  const verifiedRef = useRef(false);
  useEffect(() => {
    if (state.phase.kind !== "pillars" || state.phase.stage !== 2 || !state.phase.thinking) return;
    if (!companyId || verifiedRef.current) return;
    verifiedRef.current = true;
    void (async () => {
      try {
        const outcome = await wavexOsOnboardingApi.pillar2({
          companyId,
          claude_plan: "max_20x",
        });
        if (outcome.ok) {
          // Silent → scope picker (Pillar 3 follows the scope confirm).
          // Collapse the "Verifying setup…" transition pill that the
          // Pillar 1 confirm click dropped in.
          dispatch({ type: "COLLAPSE_LAST_SLOT", kind: "transition-pill" });
          dispatch({ type: "SET_PHASE", phase: { kind: "pillars", stage: 2, thinking: false } });
          const detected = detectScope(state.draft.pillar1?.rawInput ?? "");
          dispatch({
            type: "ADD_MESSAGE",
            message: {
              role: "assistant",
              text: detected.length > 0
                ? `Sounds like you want to focus on ${detected.length === 1 ? "one division" : `${detected.length} divisions`}. Tell me how to scope your team.`
                : "How big should this team be? You can run the full org or focus on specific divisions.",
              slot: { kind: "scope-prompt", detected },
            },
          });
        } else {
          const fixHint = (outcome as { fix_hint?: string }).fix_hint
            ?? "Claude CLI isn't responding. Check `claude --version` works on your terminal.";
          dispatch({ type: "VERIFY_FAILED", fixHint });
          dispatch({
            type: "ADD_MESSAGE",
            message: {
              role: "assistant",
              text: "I can't reach your Claude setup.",
              slot: { kind: "verify-fail", fixHint },
            },
          });
        }
      } catch (e) {
        const fixHint = e instanceof Error ? e.message : String(e);
        dispatch({ type: "VERIFY_FAILED", fixHint });
        dispatch({
          type: "ADD_MESSAGE",
          message: {
            role: "assistant",
            text: "Couldn't verify your Claude setup.",
            slot: { kind: "verify-fail", fixHint },
          },
        });
      }
    })();
  }, [state.phase, companyId]);

  /** Phase 4 — Avatar branch handlers. Each card's onSubmitted /
   *  onDone callback collapses its slot, dispatches the corresponding
   *  reducer action (which advances `state.phase`), and drops the
   *  next assistant bubble + card slot via `transitionWithPill`. Same
   *  shape as the pillar handlers above. */
  const handleAvatarProfileSubmitted = useCallback((profile: AvatarProfile, avatarId: string) => {
    dispatch({ type: "COLLAPSE_LAST_SLOT", kind: "avatar-profile" });
    dispatch({ type: "AVATAR_PROFILE_DONE", profile, avatarId });
    transitionWithPill("Wiring your tools…", () => {
      dispatch({
        type: "ADD_MESSAGE",
        message: {
          role: "assistant",
          text: "Pick the tools you live in. We use them to read for you and write back on your behalf.",
          slot: { kind: "avatar-tools", connected: [] },
        },
      });
    });
  }, [transitionWithPill]);

  const handleAvatarToolConnected = useCallback((connection: AvatarToolConnection) => {
    dispatch({ type: "AVATAR_TOOL_CONNECTED", connection });
  }, []);

  const handleAvatarToolsDone = useCallback(() => {
    dispatch({ type: "COLLAPSE_LAST_SLOT", kind: "avatar-tools" });
    dispatch({ type: "AVATAR_TOOLS_DONE" });
    transitionWithPill("Reading your voice…", () => {
      dispatch({
        type: "ADD_MESSAGE",
        message: {
          role: "assistant",
          text: "Show me how you write. Three short prompts and I'll mirror your voice.",
          slot: { kind: "avatar-voice", samples: [] },
        },
      });
    });
  }, [transitionWithPill]);

  const handleAvatarVoiceAnalyzing = useCallback(() => {
    dispatch({ type: "AVATAR_VOICE_ANALYZING" });
  }, []);

  const handleAvatarVoiceDone = useCallback((profile: AvatarVoiceProfile) => {
    dispatch({ type: "COLLAPSE_LAST_SLOT", kind: "avatar-voice" });
    dispatch({ type: "AVATAR_VOICE_DONE", profile });
    transitionWithPill("Setting trust & boundaries…", () => {
      dispatch({
        type: "ADD_MESSAGE",
        message: {
          role: "assistant",
          text: "How autonomous on day one — and what's off-limits?",
          slot: { kind: "avatar-trust" },
        },
      });
    });
  }, [transitionWithPill]);

  const handleAvatarTrustDone = useCallback((trust: AvatarTrust) => {
    dispatch({ type: "COLLAPSE_LAST_SLOT", kind: "avatar-trust" });
    dispatch({ type: "AVATAR_TRUST_DONE", trust });
    transitionWithPill("First automations…", () => {
      dispatch({
        type: "ADD_MESSAGE",
        message: {
          role: "assistant",
          text: "Pick what your avatar should start doing on day one.",
          slot: { kind: "avatar-suggestions", suggestions: [] },
        },
      });
    });
  }, [transitionWithPill]);

  const handleAvatarSuggestionsLoaded = useCallback((suggestions: AvatarAutomationSuggestion[]) => {
    dispatch({ type: "AVATAR_SUGGESTIONS_LOADED", suggestions });
  }, []);

  const handleAvatarAutomationToggled = useCallback((suggestionId: string) => {
    dispatch({ type: "AVATAR_AUTOMATION_TOGGLED", suggestionId });
  }, []);

  const handleAvatarFinalized = useCallback((avatarId: string) => {
    dispatch({ type: "COLLAPSE_LAST_SLOT", kind: "avatar-suggestions" });
    dispatch({ type: "AVATAR_FINALIZED", avatarId });
  }, []);

  const handleScopeDone = useCallback((mode: "full" | "focused", departments: Department[]) => {
    dispatch({ type: "COLLAPSE_LAST_SLOT", kind: "scope-prompt" });
    const summary = mode === "full"
      ? "Full org — got it."
      : `Focused team: ${departments.length > 0 ? departments.join(" + ") : "custom only"}.`;
    transitionWithPill("Setting up product questions…", () => {
      dispatch({ type: "SET_PHASE", phase: { kind: "pillars", stage: 3, thinking: false } });
      dispatch({
        type: "ADD_MESSAGE",
        message: {
          role: "assistant",
          text: `${summary} Where are you in the product journey?`,
          slot: { kind: "pillar3-prompt" },
        },
      });
    });
  }, [transitionWithPill]);

  const handlePillar3Done = useCallback((response: Pillar3Response) => {
    dispatch({ type: "COLLAPSE_LAST_SLOT", kind: "pillar3-prompt" });
    dispatch({ type: "PILLAR3_DONE", response });
    void (async () => {
      const text = await narrateOrFallback("pillar-3", "pillar-4", "How do leads come in?");
      transitionWithPill("Asking about your GTM…", () => {
        dispatch({
          type: "ADD_MESSAGE",
          message: { role: "assistant", text, slot: { kind: "pillar4-prompt" } },
        });
      });
    })();
  }, [transitionWithPill, narrateOrFallback]);

  const handlePillar4Done = useCallback((response: Pillar4Response) => {
    dispatch({ type: "COLLAPSE_LAST_SLOT", kind: "pillar4-prompt" });
    dispatch({ type: "PILLAR4_DONE", response });
    void (async () => {
      const text = await narrateOrFallback("pillar-4", "pillar-5", "How do you want your board to talk to you?");
      transitionWithPill("Asking about board comms…", () => {
        dispatch({
          type: "ADD_MESSAGE",
          message: { role: "assistant", text, slot: { kind: "pillar5-prompt" } },
        });
      });
    })();
  }, [transitionWithPill, narrateOrFallback]);

  const handlePillar5Done = useCallback((response: Pillar5Response) => {
    dispatch({ type: "COLLAPSE_LAST_SLOT", kind: "pillar5-prompt" });
    dispatch({ type: "PILLAR5_DONE", response });
    void (async () => {
      const text = await narrateOrFallback("pillar-5", "connectors", "Got it. Let me figure out what to plug in…");
      transitionWithPill("Mapping your connectors…", () => {
        dispatch({
          type: "ADD_MESSAGE",
          message: { role: "assistant", text, slot: { kind: "thinking", phase: "phase-2" } },
        });
      });
    })();
  }, [transitionWithPill, narrateOrFallback]);

  /** Phase 2 connector generation — fires when state.phase transitions to
   *  connectors/loading. Tries loadConnector first (no-cost) and falls back
   *  to generateConnector with skipInference=t0. */
  const connectorRanRef = useRef(false);
  useEffect(() => {
    if (state.phase.kind !== "connectors" || !state.phase.loading) return;
    if (!companyId || connectorRanRef.current) return;
    connectorRanRef.current = true;
    void (async () => {
      // Generate-connector occasionally hits a hub timeout or a transient
      // upstream blip. Auto-retry up to 2 times with backoff before giving
      // up — the customer was previously dead-ended on "HTTP 500" with no
      // path forward. This kills the most-reported "stuck on Got it. Let
      // me figure out what to plug in…" failure.
      let manifest: ConnectorManifest | null = null;
      let lastError: unknown = null;
      const MAX_ATTEMPTS = 3;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          if (attempt === 1) {
            const loaded = await wavexOsOnboardingApi.loadConnector(companyId);
            if (loaded.exists) {
              manifest = loaded.manifest as ConnectorManifest;
              break;
            }
          }
          const generated = await wavexOsOnboardingApi.generateConnector(companyId, t0);
          manifest = generated.manifest;
          break;
        } catch (e) {
          lastError = e;
          if (attempt < MAX_ATTEMPTS) {
            // 1.5s, then 3s — gives the hub time to recover from a transient.
            await new Promise((r) => setTimeout(r, attempt * 1500));
          }
        }
      }

      if (manifest) {
        dispatch({ type: "COLLAPSE_LAST_SLOT", kind: "thinking" });
        dispatch({ type: "CONNECTORS_LOADED", manifest });
        dispatch({
          type: "ADD_MESSAGE",
          message: {
            role: "assistant",
            text: "Here's the connector roster — adjust if needed, then we'll vault credentials.",
            slot: { kind: "connector-picker", manifest },
          },
        });
        return;
      }

      // All 3 attempts failed. Surface a useful, retry-suggesting message
      // instead of the opaque "HTTP 500". The thinking pill is collapsed so
      // the customer isn't stuck on "Done · 20s" with no recourse.
      dispatch({ type: "COLLAPSE_LAST_SLOT", kind: "thinking" });
      const detail = lastError instanceof Error ? lastError.message : String(lastError);
      const isTransient = /HTTP 5\d\d|timeout|fetch|network|ECONN/i.test(detail);
      dispatch({
        type: "ADD_MESSAGE",
        message: {
          role: "assistant",
          text: isTransient
            ? `Our hub blipped while picking your connectors (${detail}). I retried twice — still no luck. Refresh the page to try again, or skip to credentials manually.`
            : `Couldn't generate connector manifest: ${detail}. Refresh to try again.`,
        },
      });
    })();
  }, [state.phase, companyId, t0]);

  /** Phase 4 — Avatar entry effect. When the gateway picks "avatar" the
   *  reducer sets phase to avatar_profile directly. We drop the first
   *  assistant bubble + profile slot once. Idempotency check on the
   *  thread prevents StrictMode double-mounts from dropping twice. */
  useEffect(() => {
    if (state.phase.kind !== "avatar_profile") return;
    if (state.thread.some((m) => m.slot?.kind === "avatar-profile")) return;
    dispatch({
      type: "ADD_MESSAGE",
      message: {
        role: "assistant",
        text: "Let's set you up. Tell me a bit about yourself.",
        slot: { kind: "avatar-profile" },
      },
    });
  }, [state.phase.kind, state.thread]);

  const handleConnectorRefined = useCallback((manifest: ConnectorManifest) => {
    dispatch({ type: "CONNECTORS_LOADED", manifest });
    dispatch({
      type: "ADD_MESSAGE",
      message: {
        role: "assistant",
        text: "Re-refined. Here's the new roster.",
        slot: { kind: "connector-picker", manifest },
      },
    });
  }, []);

  const handleConnectorConfirmed = useCallback(() => {
    dispatch({ type: "COLLAPSE_LAST_SLOT", kind: "connector-picker" });
    transitionWithPill("Opening credentials…", () => {
      dispatch({ type: "CONNECTORS_CONFIRMED" });
      dispatch({
        type: "ADD_MESSAGE",
        message: {
          role: "assistant",
          text: "Vault your credentials below, then we'll build your team.",
        },
      });
    });
  }, [transitionWithPill]);

  const handleCredentialsDone = useCallback(() => {
    transitionWithPill("Assembling your AI team…", () => {
      dispatch({ type: "CREDENTIALS_DONE" });
      dispatch({
        type: "ADD_MESSAGE",
        message: {
          role: "assistant",
          text: "Connections vaulted. Assembling your AI team…",
          slot: { kind: "thinking", phase: "phase-3" },
        },
      });
    });
  }, [transitionWithPill]);

  /** Phase 3 swarm generation — fires when state transitions to
   *  swarm_transition. On completion, dispatches SWARM_LOADED which moves
   *  the phase to swarm_studio (full-screen reveal). */
  const swarmRanRef = useRef(false);
  useEffect(() => {
    if (state.phase.kind !== "swarm_transition") return;
    if (!companyId || swarmRanRef.current) return;
    swarmRanRef.current = true;
    void (async () => {
      // Same 3-attempt retry as connector manifest. Swarm generation calls
      // T2 which transient-fails on hub timeouts. Without retry the customer
      // dead-ended on "HTTP 500: internal" with no path forward.
      let manifest: SwarmManifest | null = null;
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          if (attempt === 1) {
            const loaded = await wavexOsOnboardingApi.loadSwarm(companyId);
            if (loaded.exists) {
              manifest = loaded.manifest as SwarmManifest;
              break;
            }
          }
          const generated = await wavexOsOnboardingApi.generateSwarm(companyId, t0);
          manifest = generated.manifest;
          break;
        } catch (e) {
          lastError = e;
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, attempt * 1500));
          }
        }
      }

      if (manifest) {
        // Collapse the Phase 3 thinking bubble before transitioning to
        // the Swarm Studio full-screen reveal. Avoids two T2 progress
        // indicators racing for the global inference status.
        dispatch({ type: "COLLAPSE_LAST_SLOT", kind: "thinking" });
        dispatch({ type: "SWARM_LOADED", manifest });
        return;
      }

      dispatch({ type: "COLLAPSE_LAST_SLOT", kind: "thinking" });
      const detail = lastError instanceof Error ? lastError.message : String(lastError);
      const isTransient = /HTTP 5\d\d|timeout|fetch|network|ECONN/i.test(detail);
      dispatch({
        type: "ADD_MESSAGE",
        message: {
          role: "assistant",
          text: isTransient
            ? `Our hub blipped while assembling your team (${detail}). I retried twice — still no luck. Refresh the page to try again.`
            : `Couldn't generate swarm manifest: ${detail}. Refresh to try again.`,
        },
      });
    })();
  }, [state.phase, companyId, t0]);

  const handleSwarmConfirmed = useCallback((manifest: SwarmManifest) => {
    dispatch({ type: "SWARM_CONFIRMED", manifest });
    // Workflow generation now runs inside ImprintTheater so it has the
    // exact swarm manifest in scope and isn't racing the Studio→Theater
    // transition. See packages/.../pages/ImprintTheater.tsx for the
    // serial workflow → finalize → imprint pipeline.
  }, []);

  const handleSwarmBackToChat = useCallback(() => {
    if (!state.draft.swarmManifest) {
      dispatch({ type: "SET_PHASE", phase: { kind: "credentials", drawerOpen: false } });
      return;
    }
    // Stash the studio behind the chat — operator can re-open by sending
    // any message. For simplicity, just nudge them back into the studio
    // state if they had a manifest loaded.
    dispatch({ type: "SET_PHASE", phase: { kind: "swarm_studio", manifest: state.draft.swarmManifest } });
  }, [state.draft.swarmManifest]);

  // Phases that take over the screen completely — chat thread + input
  // shouldn't render underneath, and a persistent dark backdrop bridges
  // the unmount-then-mount gap between consecutive overlays (Theater →
  // Pricing → Activate) so the chat never flashes through between them.
  const isFullScreenPhase =
    state.phase.kind === "swarm_studio" ||
    state.phase.kind === "imprint_theater" ||
    state.phase.kind === "pricing" ||
    state.phase.kind === "activate" ||
    state.phase.kind === "handed_off" ||
    // Avatar branch renders entirely in the chat thread now (Phase 4).
    // `avatar_done` stays full-screen briefly while the suggestions card
    // navigates to /avatar/:id; nothing should render under it.
    state.phase.kind === "avatar_done";

  return (
    <div style={{
      minHeight: "100vh",
      background: "var(--bg)",
      display: "flex",
      flexDirection: "column",
    }}>
      {!showEmptyState && !isFullScreenPhase && (
        <TopBar
          companyId={companyId}
          progressPct={phaseProgressPct(state.phase)}
          t0={t0}
        />
      )}
      {showEmptyState ? (
        <EmptyState
          onSubmit={handleSubmit}
          t0={t0}
          mode={showAccountTypeGateway ? "gateway" : showAvatarWelcome ? "avatar_welcome" : "input"}
          onAccountTypeSelected={handleAccountTypeSelected}
        />
      ) : !isFullScreenPhase ? (
      <ChatThread
        thread={state.thread}
        onUncollapse={(id) => dispatch({ type: "UNCOLLAPSE_MESSAGE", id })}
        slotContext={{
          companyId,
          orgName: companyId ?? deriveSlug(state.draft.pillar1?.rawInput ?? ""),
          rawInput: state.draft.pillar1?.rawInput ?? "",
          onPillar1Confirmed: () => {
            dispatch({ type: "COLLAPSE_LAST_SLOT", kind: "pillar1-confirm" });
            // The Pillar 2 verify effect fires next (silently). The pill
            // stays visible during the ~3-5s probe; the scope-prompt
            // message (added by the verify effect on success) collapses
            // it automatically because the next dispatched slot pushes
            // the pill into history.
            dispatch({
              type: "ADD_MESSAGE",
              message: { role: "assistant", text: "Verifying setup…", slot: { kind: "transition-pill", label: "Verifying setup…" } },
            });
            dispatch({ type: "PILLAR1_CONFIRMED" });
          },
          onPillar1Recovered: handlePillar1Recovery,
          onPillar3Done: handlePillar3Done,
          onPillar4Done: handlePillar4Done,
          onPillar5Done: handlePillar5Done,
          onConnectorRefined: handleConnectorRefined,
          onConnectorConfirmed: handleConnectorConfirmed,
          onScopeDone: handleScopeDone,
          avatarId: state.draft.avatarId ?? null,
          avatarProfileInitial: state.draft.avatarProfilePrefill,
          avatarToolsInitialConnected: state.draft.avatarTools ?? [],
          avatarSuggestions: state.draft.avatarSuggestions ?? [],
          avatarEnabledAutomations: state.draft.avatarEnabledAutomations ?? [],
          onAvatarProfileSubmitted: handleAvatarProfileSubmitted,
          onAvatarToolConnected: handleAvatarToolConnected,
          onAvatarToolsDone: handleAvatarToolsDone,
          onAvatarVoiceAnalyzing: handleAvatarVoiceAnalyzing,
          onAvatarVoiceDone: handleAvatarVoiceDone,
          onAvatarTrustDone: handleAvatarTrustDone,
          onAvatarSuggestionsLoaded: handleAvatarSuggestionsLoaded,
          onAvatarAutomationToggled: handleAvatarAutomationToggled,
          onAvatarFinalized: handleAvatarFinalized,
        }}
      />
      ) : null}
      {!showEmptyState && !isFullScreenPhase && (
        <ChatInput onSubmit={handleSubmit} disabled={state.phase.kind === "welcome" ? false : state.phase.kind === "pillars" && state.phase.thinking} />
      )}
      {/* Free-form HelpChat — always reachable once we have a companyId. The
       *  main ChatInput is phase-locked (each message becomes a pillar submit
       *  for the active stage), so the customer otherwise has no surface to
       *  ask "wait, what does this mean?" or "should I pick X or Y?" mid-walk.
       *  HelpChat is a Pool-A-backed concierge that knows the customer's full
       *  pillar context — opens as a collapsible right-edge drawer. */}
      {companyId && (
        <HelpChat
          companyId={companyId}
          phase={
            state.phase.kind === "pillars" && state.phase.stage
              ? `pillar-${state.phase.stage}`
              : state.phase.kind
          }
        />
      )}
      {/* Persistent dark backdrop for full-screen phases — bridges the
       *  unmount-then-mount gap when transitioning Theater → Pricing →
       *  Activate so the chat thread doesn't flash through underneath. */}
      {isFullScreenPhase && (
        <div style={{
          position: "fixed",
          inset: 0,
          background: "#0a0a0c",
          zIndex: 40,
        }} />
      )}
      {state.phase.kind === "credentials" && companyId && (
        <CredentialDrawer
          companyId={companyId}
          onDone={handleCredentialsDone}
          onCancel={() => dispatch({ type: "SET_PHASE", phase: { kind: "connectors", loading: false, manifest: state.draft.connectorManifest } })}
        />
      )}
      {state.phase.kind === "swarm_studio" && companyId && (
        <SwarmStudio
          companyId={companyId}
          manifest={state.phase.manifest}
          onConfirmed={() => handleSwarmConfirmed(state.phase.kind === "swarm_studio" ? state.phase.manifest : state.draft.swarmManifest!)}
          onBackToChat={handleSwarmBackToChat}
        />
      )}
      {state.phase.kind === "imprint_theater" && companyId && (
        <ImprintTheater
          companyId={companyId}
          onLaunch={() => dispatch({ type: "OPEN_PRICING" })}
        />
      )}
      {state.phase.kind === "pricing" && companyId && (
        <Pricing
          companyId={companyId}
          dialogMode
          onContinue={() => dispatch({ type: "PRICING_DONE" })}
        />
      )}
      {state.phase.kind === "activate" && companyId && state.draft.swarmManifest && (
        <ActivateProgress
          companyId={companyId}
          swarmManifest={state.draft.swarmManifest}
        />
      )}

      {/* ── Avatar branch ─────────────────────────────────────────────────
       *  Each step renders a single centered card on top of the bg layer.
       *  No chat thread, no input bar — the Avatar flow is form-shaped,
       *  not conversational, so we use full-screen overlays instead.
       */}
    </div>
  );
}

// ── Empty state (hero) ────────────────────────────────────────────────────

function EmptyState({
  onSubmit, t0, mode = "input", onAccountTypeSelected,
}: {
  onSubmit: (text: string) => void;
  t0: boolean;
  mode?: "gateway" | "input" | "avatar_welcome";
  onAccountTypeSelected?: (type: AccountType) => void;
}) {
  const [draft, setDraft] = useState("");
  // `submitting` triggers the phase-out animation. We render with reduced
  // opacity + slight upward translate for ~350ms before calling onSubmit
  // so the welcome content doesn't snap-cut into the chat thread.
  const [submitting, setSubmitting] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => { ref.current?.focus(); }, []);

  function send(text: string): void {
    const t = text.trim();
    if (!t || submitting) return;
    setSubmitting(true);
    // Let the fade-out animation play before we hand the input upstream.
    // 350ms feels deliberate without dragging.
    window.setTimeout(() => {
      setDraft("");
      onSubmit(t);
    }, 350);
  }

  function handleKey(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(draft);
    }
  }

  /** Generalized starter patterns — each reveals one valid input shape
   *  without prescribing a specific business. Click to seed the input
   *  with a template the operator edits; doesn't auto-submit. */
  const STARTERS: Array<{ label: string; seed: string }> = mode === "avatar_welcome"
    ? [
        { label: "Who you are", seed: "I'm " },
        { label: "Your role", seed: "I work as a " },
        { label: "First thing to delegate", seed: "I'd hand off " },
      ]
    : [
        { label: "Your company URL", seed: "https://" },
        { label: "Pitch in one sentence", seed: "We build " },
        { label: "Scoped: just marketing & sales", seed: "I need a marketing and sales team for " },
      ];

  function applyStarter(seed: string): void {
    setDraft(seed);
    // Move cursor to end so the operator can keep typing immediately.
    requestAnimationFrame(() => {
      if (ref.current) {
        ref.current.focus();
        ref.current.setSelectionRange(seed.length, seed.length);
      }
    });
  }

  return (
    <div style={{
      flex: 1,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      padding: "1.5rem",
      gap: "2rem",
    }}>
      <div style={{ position: "absolute", top: "1.25rem", left: "1.5rem", display: "flex", alignItems: "center", gap: "0.65rem" }}>
        <Wordmark size="hero" />
        {t0 && (
          <span
            title="Fast mode (?t0=1): every T2 inference call returns a deterministic fallback. No claude CLI required, no token cost. Drop the ?t0=1 from the URL for real inference."
            style={{
              fontSize: 10, padding: "0.1rem 0.45rem",
              border: "1px solid var(--warning)",
              color: "var(--warning)",
              borderRadius: 999,
              cursor: "help",
            }}
          >
            Fast mode
          </span>
        )}
      </div>

      <div style={{
        maxWidth: 720,
        width: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "2rem",
        // Phase-out: when submitting, fade + drift up so the welcome
        // content gracefully steps aside before the chat thread mounts.
        opacity: submitting ? 0 : 1,
        transform: submitting ? "translateY(-12px)" : "translateY(0)",
        transition: "opacity 320ms ease-out, transform 320ms ease-out",
        pointerEvents: submitting ? "none" : "auto",
      }}>
        <div style={{ textAlign: "center" }}>
          <h1 style={{ fontSize: 30, fontWeight: 700, margin: 0, marginBottom: "0.6rem", letterSpacing: "-0.01em" }}>
            {mode === "gateway"
              ? "Welcome to WaveX OS"
              : mode === "avatar_welcome"
                ? "Let's get to know you"
                : "What do you want to build?"}
          </h1>
          <p className="text-dim" style={{ fontSize: 14, margin: 0, lineHeight: 1.55 }}>
            {mode === "gateway" ? (
              <>
                Pick how you want to work — a personal Avatar, a full AI company, or
                <br />
                a hybrid that fills the gaps in your team.
              </>
            ) : mode === "avatar_welcome" ? (
              <>
                Tell me your name, role, hours you work, and what you'd hand off first.
                <br />
                I'll set up the rest from your answer.
              </>
            ) : (
              <>
                Drop a URL, describe your company, or tell me what kind of AI team you need.
                <br />
                I'll infer your stack, propose a fleet, and walk you to launch.
              </>
            )}
          </p>
        </div>

        {mode === "gateway" && onAccountTypeSelected ? (
          <div style={{ width: "100%" }}>
            <AccountTypeSelectCard onChoose={onAccountTypeSelected} />
          </div>
        ) : (
        <>
        <div style={{
          width: "100%",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          padding: "0.85rem 1rem 0.85rem 1.1rem",
          display: "flex",
          alignItems: "flex-end",
          gap: "0.75rem",
          boxShadow: "0 1px 0 rgba(255,255,255,0.02), 0 8px 24px rgba(0,0,0,0.25)",
        }}>
          <textarea
            ref={ref}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKey}
            placeholder={mode === "avatar_welcome" ? "I'm…" : "Ask anything…"}
            rows={1}
            disabled={submitting}
            style={{
              flex: 1,
              resize: "none",
              padding: "0.55rem 0",
              background: "transparent",
              border: "none",
              outline: "none",
              color: "var(--text)",
              fontSize: 15,
              fontFamily: "inherit",
              lineHeight: 1.5,
              minHeight: 28,
              maxHeight: 200,
            }}
          />
          <button
            type="button"
            onClick={() => send(draft)}
            disabled={!draft.trim() || submitting}
            style={{
              padding: "0.55rem 0.8rem",
              borderRadius: 10,
              background: draft.trim() ? "var(--accent)" : "var(--surface-2)",
              color: draft.trim() ? "var(--bg)" : "var(--text-dim)",
              border: "none",
              fontWeight: 700,
              fontSize: 13,
              cursor: draft.trim() && !submitting ? "pointer" : "not-allowed",
              transition: "background 0.15s, color 0.15s",
            }}
          >
            ↑
          </button>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", justifyContent: "center" }}>
          {STARTERS.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => applyStarter(s.seed)}
              style={{
                padding: "0.4rem 0.85rem",
                borderRadius: 999,
                background: "transparent",
                color: "var(--text-dim)",
                border: "1px solid var(--border)",
                fontSize: 12,
                cursor: "pointer",
                transition: "color 0.15s, border-color 0.15s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--text)";
                e.currentTarget.style.borderColor = "var(--accent)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--text-dim)";
                e.currentTarget.style.borderColor = "var(--border)";
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
        </>
        )}

      </div>
    </div>
  );
}

// ── Top bar ───────────────────────────────────────────────────────────────

/** Inference-source chip — reflects what's TRUE for a paying customer's
 *  Pool B path. Replaces the old probe-of-local-CLI which always reported
 *  "offline" on customer machines (no local hosted-shim, no local Claude
 *  CLI) even when their Supabase-Realtime Pool B inference was fully
 *  functional.
 *
 *  Source of truth: GET /api/inference-status on the wavex-os server
 *  (reads ~/.wavex-os/device-token.json + verifies JWT, no network).
 *
 *    online + mode="pool_b"  → "✓ Inference online · Pool B"
 *    offline                 → "○ Inference offline" + pair-device hint
 *
 *  Polls on mount + every 30 s so a fresh `wavex-os login` reflects
 *  without a page reload. */
interface InferenceStatusResp {
  ok: boolean;
  online: boolean;
  mode: "pool_b" | "offline";
  user_id?: string;
  expires_at?: number;
  reason?: string;
  /** Set when the route auto-refreshed an expired access_token during this
   *  poll. The chip shows a brief "(refreshed)" tag so the customer sees the
   *  self-heal happened. */
  refreshed?: boolean;
}

function HubTransparencyChip() {
  const [status, setStatus] = useState<InferenceStatusResp | null>(null);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await fetch("/api/inference-status");
        const j = (await r.json()) as InferenceStatusResp;
        if (!cancelled) setStatus(j);
      } catch {
        if (!cancelled) setStatus({ ok: true, online: false, mode: "offline", reason: "fetch_failed" });
      }
    };
    void poll();
    const t = window.setInterval(() => void poll(), 30_000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, []);
  if (!status) return null;
  const isOk = status.online;
  // Map server-side reasons to a CUSTOMER-FACING message that never asks
  // for a terminal command. "expired" no longer appears as a terminal
  // state — the server auto-refreshes; only "refresh_failed" or "no_bundle"
  // reach the user.
  const offlineCopy =
    status.reason === "refresh_failed"  ? "Reconnect device"  :
    status.reason === "no_bundle"       ? "Pair device"       :
    status.reason === "fetch_failed"    ? "Reconnecting…"     :
    "Pair device";
  const label = isOk
    ? (status.refreshed ? "Inference online · Pool B (refreshed)" : "Inference online · Pool B")
    : "Inference offline";
  const title = isOk
    ? `Pool B reachable — paired as ${status.user_id ?? "device"}, token valid until ${
        status.expires_at ? new Date(status.expires_at * 1000).toLocaleTimeString() : "unknown"
      }. Inference runs on the operator's Mac via Supabase Realtime, billed under your subscription.`
    : status.reason === "refresh_failed"
      ? `Could not refresh the device token — the refresh token may have been revoked or your network is offline. Click "Reconnect device" to pair again.`
      : status.reason === "fetch_failed"
        ? `Could not reach the local wavex-os server. It may still be starting up — this resolves itself within a few seconds.`
        : `This machine isn't paired yet. Click "Pair device" to set it up.`;
  return (
    <span
      title={title}
      style={{
        fontSize: 10, padding: "0.1rem 0.45rem",
        border: `1px solid ${isOk ? "var(--accent)" : "var(--warning)"}`,
        color: isOk ? "var(--accent)" : "var(--warning)",
        borderRadius: 999,
        marginLeft: "0.25rem",
        cursor: "help",
        fontWeight: 500,
        whiteSpace: "nowrap",
      }}
    >
      {isOk ? "✓ " : "○ "}{label}
      {!isOk && status.reason !== "fetch_failed" && (
        <span style={{ marginLeft: "0.35rem", textDecoration: "underline", opacity: 0.8 }}>
          {offlineCopy}
        </span>
      )}
    </span>
  );
}

function TopBar({
  companyId, progressPct, t0,
}: {
  companyId: string | null;
  progressPct: number;
  t0: boolean;
}) {
  return (
    <header style={{
      position: "sticky", top: 0, zIndex: 10,
      background: "color-mix(in srgb, var(--bg) 85%, transparent)",
      backdropFilter: "blur(8px)",
      padding: "0.6rem 1.25rem",
      display: "flex", alignItems: "center", gap: "1rem",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", minWidth: 0 }}>
        <Wordmark size="compact" />
        {companyId && (
          <span className="text-dim" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            · <code>{companyId}</code>
          </span>
        )}
        <HubTransparencyChip />
        <SystemHealthChip />
        {t0 && (
          <span
            title="Fast mode (?t0=1): every T2 inference call returns a deterministic fallback. No claude CLI required, no token cost. Drop the ?t0=1 from the URL for real inference."
            style={{
              fontSize: 10, padding: "0.1rem 0.45rem",
              border: "1px solid var(--warning)",
              color: "var(--warning)",
              borderRadius: 999,
              marginLeft: "0.25rem",
              cursor: "help",
            }}
          >
            Fast mode
          </span>
        )}
      </div>

      <div style={{ flex: 1, height: 2, background: "var(--border)", borderRadius: 2, overflow: "hidden", opacity: 0.6 }}>
        <div style={{
          height: "100%",
          width: `${progressPct}%`,
          background: "var(--accent)",
          transition: "width 0.4s ease-out",
        }} />
      </div>

      {companyId && (
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <TokenCounter companyId={companyId} />
          <BudgetChip companyId={companyId} />
        </div>
      )}
    </header>
  );
}

// ── Chat thread ───────────────────────────────────────────────────────────

interface SlotContext {
  companyId: string | null;
  orgName: string;
  rawInput: string;
  onPillar1Confirmed: () => void;
  onPillar1Recovered: (response: Pillar1Response) => void;
  onPillar3Done: (response: Pillar3Response) => void;
  onPillar4Done: (response: Pillar4Response) => void;
  onPillar5Done: (response: Pillar5Response) => void;
  onConnectorRefined: (manifest: ConnectorManifest) => void;
  onConnectorConfirmed: () => void;
  onScopeDone: (mode: "full" | "focused", departments: Department[]) => void;
  // Phase 4 — Avatar branch as inline chat cards
  avatarId: string | null;
  avatarProfileInitial: AvatarProfilePrefill | undefined;
  avatarToolsInitialConnected: AvatarToolConnection[];
  avatarSuggestions: AvatarAutomationSuggestion[];
  avatarEnabledAutomations: string[];
  onAvatarProfileSubmitted: (profile: AvatarProfile, avatarId: string) => void;
  onAvatarToolConnected: (connection: AvatarToolConnection) => void;
  onAvatarToolsDone: () => void;
  onAvatarVoiceAnalyzing: () => void;
  onAvatarVoiceDone: (profile: AvatarVoiceProfile) => void;
  onAvatarTrustDone: (trust: AvatarTrust) => void;
  onAvatarSuggestionsLoaded: (suggestions: AvatarAutomationSuggestion[]) => void;
  onAvatarAutomationToggled: (suggestionId: string) => void;
  onAvatarFinalized: (avatarId: string) => void;
}

function ChatThread({ thread, slotContext, onUncollapse }: { thread: ChatMessage[]; slotContext: SlotContext; onUncollapse: (id: string) => void }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLDivElement | null>(null);

  // The most recent bubble that carries an interactive slot AND isn't yet
  // collapsed is the "active" card — gets a subtle accent border + glow so
  // the operator's eye knows where to act. Excludes thinking + transition-
  // pill slots since neither is a card the operator interacts with.
  const activeIdx = (() => {
    for (let i = thread.length - 1; i >= 0; i--) {
      const m = thread[i];
      if (!m.collapsed && m.slot && m.slot.kind !== "thinking" && m.slot.kind !== "transition-pill") return i;
    }
    return -1;
  })();

  // Keep the active card in the viewport's natural sight line as the thread
  // grows. Without this, new content pins to the bottom edge of the
  // container and the operator has to read up to find the live card.
  // Falls back to scroll-to-bottom when no active card exists (e.g.,
  // assistant-only chitchat).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (activeRef.current && activeIdx >= 0) {
      activeRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [thread.length, thread[thread.length - 1]?.text, thread[thread.length - 1]?.collapsed, activeIdx]);

  return (
    <div
      ref={scrollRef}
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "1.5rem 1rem 6rem",
      }}
    >
      <div style={{ maxWidth: 760, margin: "0 auto", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        {thread.map((m, i) => {
          const isActive = i === activeIdx;
          return (
            <div key={m.id} ref={isActive ? activeRef : null}>
              <ChatBubble message={m} slotContext={slotContext} active={isActive} onUncollapse={onUncollapse} />
            </div>
          );
        })}
        {/* Tail spacer — keeps the active card centerable even when it's the
         *  last item in the thread (otherwise scrollIntoView block:center
         *  can't move past the container's natural bottom). */}
        <div style={{ height: "30vh", flex: "0 0 auto" }} aria-hidden />
      </div>
    </div>
  );
}

function ChatBubble({ message, slotContext, active, onUncollapse }: { message: ChatMessage; slotContext: SlotContext; active: boolean; onUncollapse: (id: string) => void }) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  // Transition pills render as small directional indicators, not full chat
  // bubbles. They show during the gap between submitting a card and the
  // next one mounting, so the operator's eye knows the system is advancing.
  if (message.slot?.kind === "transition-pill" && !message.collapsed) {
    return (
      <div style={{
        alignSelf: "flex-start",
        display: "inline-flex",
        alignItems: "center",
        gap: "0.5rem",
        padding: "0.3rem 0.75rem",
        borderRadius: 999,
        border: "1px solid var(--border)",
        background: "transparent",
        color: "var(--text-dim)",
        fontSize: 11,
        opacity: 0.85,
        animation: "wavex-fade-in 200ms ease-out",
      }}>
        <span className="wavex-pulse-dot" style={{ fontSize: 14, lineHeight: 1, letterSpacing: "0.05em" }}>•••</span>
        <span>{message.slot.label}</span>
      </div>
    );
  }

  if (message.collapsed) {
    // Card-bearing breadcrumbs (any slot that's editable) are clickable
    // to re-expand. Pillar 1 confirm + Pillars 3/4/5 prompts. Other
    // collapsed messages (text-only, thinking, transition-pill) stay
    // static as visual history.
    const editableKinds = new Set([
      "pillar1-confirm", "pillar3-prompt", "pillar4-prompt", "pillar5-prompt", "scope-prompt", "connector-picker",
    ]);
    const editable = message.slot && editableKinds.has(message.slot.kind);
    return (
      <div
        className="text-dim"
        onClick={editable ? () => onUncollapse(message.id) : undefined}
        title={editable ? "Click to redo this step (re-walks from here)" : undefined}
        style={{
          fontSize: 11,
          alignSelf: isUser ? "flex-end" : "flex-start",
          padding: "0.2rem 0.6rem",
          borderLeft: "2px solid var(--border)",
          opacity: 0.55,
          animation: "wavex-fade-in 250ms ease-out",
          cursor: editable ? "pointer" : "default",
        }}
        onMouseEnter={editable ? (e) => { e.currentTarget.style.opacity = "0.85"; } : undefined}
        onMouseLeave={editable ? (e) => { e.currentTarget.style.opacity = "0.55"; } : undefined}
      >
        ✓ {message.text ? message.text.split("\n")[0].slice(0, 80) : "(handled)"}{editable ? " · redo" : ""}
      </div>
    );
  }

  const accent = active && !isUser && !isSystem;

  return (
    <div style={{
      alignSelf: isUser ? "flex-end" : "flex-start",
      maxWidth: message.slot ? "95%" : "85%",
      padding: "0.6rem 0.85rem",
      borderRadius: 10,
      background: isUser ? "var(--accent)" : isSystem ? "transparent" : "var(--surface)",
      color: isUser ? "var(--bg)" : "var(--text)",
      border: isUser ? "none" : `1px solid ${accent ? "var(--accent)" : "var(--border)"}`,
      boxShadow: accent ? "0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent)" : undefined,
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      fontSize: 13,
      lineHeight: 1.5,
      transition: "border-color 0.3s ease-out, box-shadow 0.3s ease-out",
      animation: "wavex-fade-in 250ms ease-out",
    }}>
      {message.text}
      {message.slot && <SlotRenderer slot={message.slot} slotContext={slotContext} />}
    </div>
  );
}

/** Maps a chat slot tag to its inline-component implementation. */
function SlotRenderer({ slot, slotContext }: { slot: ChatSlot; slotContext: SlotContext }) {
  switch (slot.kind) {
    case "thinking":
      return (
        <div style={{ marginTop: "0.5rem" }}>
          <T2ProgressIndicator active={true} phase={slot.phase} />
        </div>
      );
    case "pillar1-confirm":
      if (!slotContext.companyId) return null;
      return (
        <Pillar1ConfirmCard
          companyId={slotContext.companyId}
          response={slot.response}
          onConfirmed={slotContext.onPillar1Confirmed}
        />
      );
    case "pillar1-halt":
      if (!slotContext.companyId) return null;
      return (
        <Pillar1HaltCard
          companyId={slotContext.companyId}
          orgName={slotContext.orgName}
          rawInput={slotContext.rawInput}
          onRecovered={slotContext.onPillar1Recovered}
        />
      );
    case "scope-prompt":
      if (!slotContext.companyId) return null;
      return (
        <ScopePromptCard
          companyId={slotContext.companyId}
          detected={slot.detected as Department[]}
          onDone={slotContext.onScopeDone}
        />
      );
    case "pillar3-prompt":
      if (!slotContext.companyId) return null;
      return <Pillar3PromptCard companyId={slotContext.companyId} onDone={slotContext.onPillar3Done} />;
    case "pillar4-prompt":
      if (!slotContext.companyId) return null;
      return <Pillar4PromptCard companyId={slotContext.companyId} onDone={slotContext.onPillar4Done} />;
    case "pillar5-prompt":
      if (!slotContext.companyId) return null;
      return <Pillar5PromptCard companyId={slotContext.companyId} onDone={slotContext.onPillar5Done} />;
    case "verify-fail":
      return (
        <div style={{ marginTop: "0.5rem", padding: "0.6rem 0.75rem", background: "var(--bg)", border: "1px solid var(--warning)", borderRadius: 6, fontSize: 12 }}>
          <div style={{ color: "var(--warning)", fontWeight: 600, marginBottom: "0.25rem" }}>Fix hint</div>
          <div style={{ whiteSpace: "pre-wrap" }}>{slot.fixHint}</div>
          <div className="text-dim" style={{ marginTop: "0.5rem", fontSize: 11 }}>
            Once resolved, reload the page to retry verification.
          </div>
        </div>
      );
    case "connector-picker":
      if (!slotContext.companyId) return null;
      return (
        <ConnectorPickerCard
          companyId={slotContext.companyId}
          manifest={slot.manifest}
          onConfirmed={slotContext.onConnectorConfirmed}
          onReRefined={slotContext.onConnectorRefined}
        />
      );
    // Phase 4 — Avatar steps render inline as chat cards (parity with
    // Solo/Hybrid). Profile + Tools land in slice 2; voice/trust/sugg
    // come in slice 3.
    case "avatar-profile":
      return (
        <AvatarProfileCard
          initial={slotContext.avatarProfileInitial}
          onSubmitted={slotContext.onAvatarProfileSubmitted}
        />
      );
    case "avatar-tools":
      if (!slotContext.avatarId) return null;
      return (
        <AvatarToolsCard
          avatarId={slotContext.avatarId}
          initialConnected={slotContext.avatarToolsInitialConnected}
          onConnected={slotContext.onAvatarToolConnected}
          onDone={slotContext.onAvatarToolsDone}
        />
      );
    case "avatar-voice":
      if (!slotContext.avatarId) return null;
      return (
        <AvatarVoiceCard
          avatarId={slotContext.avatarId}
          onAnalyzing={slotContext.onAvatarVoiceAnalyzing}
          onDone={slotContext.onAvatarVoiceDone}
        />
      );
    case "avatar-trust":
      if (!slotContext.avatarId) return null;
      return (
        <AvatarTrustCard
          avatarId={slotContext.avatarId}
          onDone={slotContext.onAvatarTrustDone}
        />
      );
    case "avatar-suggestions":
      if (!slotContext.avatarId) return null;
      return (
        <AvatarSuggestionsCard
          avatarId={slotContext.avatarId}
          suggestions={slotContext.avatarSuggestions}
          enabled={slotContext.avatarEnabledAutomations}
          onSuggestionsLoaded={slotContext.onAvatarSuggestionsLoaded}
          onToggle={slotContext.onAvatarAutomationToggled}
          onFinalized={slotContext.onAvatarFinalized}
        />
      );
    default:
      return null;
  }
}

// ── Persistent input ──────────────────────────────────────────────────────

function ChatInput({
  onSubmit, disabled,
}: {
  onSubmit: (text: string) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  function handleKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = draft;
      setDraft("");
      onSubmit(text);
    }
  }

  return (
    <div style={{
      position: "fixed", bottom: 0, left: 0, right: 0,
      background: "linear-gradient(to top, var(--bg) 60%, transparent)",
      padding: "1rem 1rem 1.25rem",
      zIndex: 20,
    }}>
      <div style={{
        maxWidth: 720,
        margin: "0 auto",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 14,
        padding: "0.7rem 0.85rem 0.7rem 1.05rem",
        display: "flex",
        alignItems: "flex-end",
        gap: "0.65rem",
        boxShadow: "0 1px 0 rgba(255,255,255,0.02), 0 8px 24px rgba(0,0,0,0.3)",
      }}>
        <textarea
          ref={ref}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKey}
          placeholder={disabled ? "Working…" : "Ask anything…"}
          disabled={disabled}
          rows={1}
          style={{
            flex: 1,
            resize: "none",
            padding: "0.4rem 0",
            background: "transparent",
            border: "none",
            outline: "none",
            color: "var(--text)",
            fontSize: 14,
            fontFamily: "inherit",
            lineHeight: 1.5,
            minHeight: 24,
            maxHeight: 200,
          }}
        />
        <button
          type="button"
          onClick={() => { const text = draft; setDraft(""); onSubmit(text); }}
          disabled={disabled || !draft.trim()}
          style={{
            padding: "0.45rem 0.7rem",
            borderRadius: 10,
            background: draft.trim() && !disabled ? "var(--accent)" : "var(--surface-2)",
            color: draft.trim() && !disabled ? "var(--bg)" : "var(--text-dim)",
            border: "none",
            fontWeight: 700,
            fontSize: 13,
            cursor: disabled || !draft.trim() ? "not-allowed" : "pointer",
            transition: "background 0.15s, color 0.15s",
            minWidth: 36,
          }}
        >
          ↑
        </button>
      </div>
    </div>
  );
}
