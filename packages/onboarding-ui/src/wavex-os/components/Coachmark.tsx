/** Phase 7-B — first-run coachmark walkthrough overlay.
 *
 *  Renders a dimmed backdrop, a highlight ring around the current
 *  step's target element, and a floating card with title + body +
 *  navigation. Auto-positions the card near the highlight, clamping
 *  to viewport edges. Re-measures on scroll / resize.
 *
 *  Usage:
 *    <CoachmarkOverlay
 *      steps={[
 *        { target: () => document.querySelector("[data-tour='inbox-tab']"),
 *          title: "Inbox", body: "…" },
 *        …
 *      ]}
 *      onDone={() => …}
 *    />
 *
 *  If a step's target() returns null (e.g., tab is hidden), the card
 *  centers in the viewport without a highlight ring.
 */

import { useEffect, useLayoutEffect, useState } from "react";

export interface CoachmarkStep {
  target: () => HTMLElement | null;
  title: string;
  body: string;
  /** Fires once when the step becomes active (or on initial mount).
   *  Use this to switch tabs / scroll / open a panel so the target
   *  becomes visible before measurement happens. */
  onEnter?: () => void;
}

interface Props {
  steps: CoachmarkStep[];
  onDone: () => void;
}

interface Rect { top: number; left: number; width: number; height: number }

const CARD_W = 320;
const CARD_GAP = 14;
const EDGE_PADDING = 16;
const RING_PADDING = 6;

function getRect(el: HTMLElement | null): Rect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Pick a card position near the target rect that fits the viewport. */
function placeCard(target: Rect | null, cardHeight: number, vw: number, vh: number): { top: number; left: number; arrow: "up" | "down" | "left" | "right" | null } {
  if (!target) {
    return {
      top: vh / 2 - cardHeight / 2,
      left: vw / 2 - CARD_W / 2,
      arrow: null,
    };
  }
  // Prefer right of target.
  if (target.left + target.width + CARD_GAP + CARD_W + EDGE_PADDING <= vw) {
    return {
      top: clamp(target.top + target.height / 2 - cardHeight / 2, EDGE_PADDING, vh - cardHeight - EDGE_PADDING),
      left: target.left + target.width + CARD_GAP,
      arrow: "left",
    };
  }
  // Else left.
  if (target.left - CARD_GAP - CARD_W - EDGE_PADDING >= 0) {
    return {
      top: clamp(target.top + target.height / 2 - cardHeight / 2, EDGE_PADDING, vh - cardHeight - EDGE_PADDING),
      left: target.left - CARD_GAP - CARD_W,
      arrow: "right",
    };
  }
  // Else below.
  if (target.top + target.height + CARD_GAP + cardHeight + EDGE_PADDING <= vh) {
    return {
      top: target.top + target.height + CARD_GAP,
      left: clamp(target.left + target.width / 2 - CARD_W / 2, EDGE_PADDING, vw - CARD_W - EDGE_PADDING),
      arrow: "up",
    };
  }
  // Else above.
  if (target.top - CARD_GAP - cardHeight - EDGE_PADDING >= 0) {
    return {
      top: target.top - CARD_GAP - cardHeight,
      left: clamp(target.left + target.width / 2 - CARD_W / 2, EDGE_PADDING, vw - CARD_W - EDGE_PADDING),
      arrow: "down",
    };
  }
  // Last resort: center.
  return {
    top: vh / 2 - cardHeight / 2,
    left: vw / 2 - CARD_W / 2,
    arrow: null,
  };
}

export function CoachmarkOverlay({ steps, onDone }: Props) {
  const [index, setIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  const [cardHeight, setCardHeight] = useState(160);
  const [vw, setVw] = useState(typeof window !== "undefined" ? window.innerWidth : 1440);
  const [vh, setVh] = useState(typeof window !== "undefined" ? window.innerHeight : 900);
  const step = steps[index];

  // Fire the step's onEnter side effect (tab switch / panel open) once per step entry.
  useEffect(() => { step?.onEnter?.(); }, [index, step]);

  // Measure the current step's target. Re-measure on step change, scroll,
  // resize, and after a microtask in case the target mounts late.
  useLayoutEffect(() => {
    if (!step) return;
    function measure() {
      const el = step.target();
      // Scroll the target into view if it's outside the viewport.
      if (el && (el.getBoundingClientRect().top < 0 || el.getBoundingClientRect().bottom > window.innerHeight)) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      setTargetRect(getRect(el));
      setVw(window.innerWidth);
      setVh(window.innerHeight);
    }
    measure();
    const id = window.setTimeout(measure, 80); // late-mount fallback
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [step, index]);

  // Card height is dynamic — measure once it renders.
  const cardRef = (node: HTMLDivElement | null): void => {
    if (node) setCardHeight(node.getBoundingClientRect().height);
  };

  if (!step) return null;

  const placement = placeCard(targetRect, cardHeight, vw, vh);
  const isLast = index === steps.length - 1;

  return (
    <>
      {/* Dim backdrop */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0, 0, 0, 0.55)",
          zIndex: 9000,
          pointerEvents: "auto",
        }}
        onClick={() => { /* swallow — must use buttons */ }}
      />

      {/* Highlight ring around the target */}
      {targetRect && (
        <div
          style={{
            position: "fixed",
            top: targetRect.top - RING_PADDING,
            left: targetRect.left - RING_PADDING,
            width: targetRect.width + RING_PADDING * 2,
            height: targetRect.height + RING_PADDING * 2,
            border: "2px solid var(--accent)",
            borderRadius: 10,
            boxShadow: "0 0 0 4px color-mix(in srgb, var(--accent) 18%, transparent), 0 0 32px -4px color-mix(in srgb, var(--accent) 60%, transparent)",
            zIndex: 9001,
            pointerEvents: "none",
            transition: "top 0.2s ease, left 0.2s ease, width 0.2s ease, height 0.2s ease",
          }}
        />
      )}

      {/* Coachmark card */}
      <div
        ref={cardRef}
        style={{
          position: "fixed",
          top: placement.top,
          left: placement.left,
          width: CARD_W,
          zIndex: 9002,
          background: "var(--surface)",
          border: "1px solid color-mix(in srgb, var(--accent) 40%, var(--border))",
          borderRadius: 10,
          padding: "1rem 1.1rem",
          boxShadow: "0 18px 40px -8px rgba(0,0,0,0.5), 0 0 0 1px color-mix(in srgb, var(--accent) 16%, transparent)",
          display: "flex", flexDirection: "column", gap: "0.6rem",
          transition: "top 0.2s ease, left 0.2s ease",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--accent)" }}>
            Step {index + 1} of {steps.length}
          </div>
          <button
            type="button"
            onClick={onDone}
            style={{
              background: "transparent", border: "none", color: "var(--text-dim)",
              fontSize: 11, cursor: "pointer", padding: "14px 8px", minHeight: 44,
            }}
          >
            Skip tour
          </button>
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)", lineHeight: 1.3 }}>
          {step.title}
        </div>
        <div style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.55 }}>
          {step.body}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "0.25rem" }}>
          <div style={{ display: "flex", gap: "0.35rem" }}>
            {steps.map((_, i) => (
              <div
                key={i}
                style={{
                  width: 6, height: 6, borderRadius: 999,
                  background: i === index ? "var(--accent)" : "var(--border)",
                  transition: "background 0.15s",
                }}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              if (isLast) onDone();
              else setIndex((i) => i + 1);
            }}
            style={{
              padding: "0.4rem 0.9rem", borderRadius: 6,
              background: "var(--accent)", color: "var(--bg)",
              border: "none", fontWeight: 600, fontSize: 12,
              cursor: "pointer", minHeight: 44,
            }}
          >
            {isLast ? "Got it" : "Next →"}
          </button>
        </div>
      </div>
    </>
  );
}
