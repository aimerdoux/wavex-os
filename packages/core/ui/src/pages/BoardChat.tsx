/** Kernel chat — full-page route mounted from the sidebar
 *  (below Dashboard). Operator's primary lens into the live fleet.
 *  (The chat UI surface is named "Kernel"; it is still backed by the
 *  company's Chief of Staff agent server-side via help-chat board mode.)
 *  Reuses wavex help-chat in board mode for the T2 reply, augmented with:
 *    - markdown rendering of replies
 *    - char-by-char reveal of the newest assistant message ("streaming")
 *    - inline action chips ([[ACTION:type:arg]]) for one-click
 *      pause/resume on agents or the whole fleet
 *    - current pathname forwarded so the CoS biases its answer toward
 *      the page the operator is actually viewing */

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircle, Send, PauseCircle, PlayCircle } from "lucide-react";
import { useLocation } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { wavexApi, deriveWavexCompanyId, WavexFetchError } from "../lib/wavex-link";

// ── Action chip parsing ────────────────────────────────────────────────

type ParsedAction =
  | { type: "pause-agent"; slot: string }
  | { type: "resume-agent"; slot: string }
  | { type: "pause-fleet" }
  | { type: "resume-fleet" };

const ACTION_RE = /\[\[ACTION:([a-z-]+)(?::([^\]]+))?\]\]/g;

function parseMessage(text: string): { display: string; actions: ParsedAction[] } {
  const actions: ParsedAction[] = [];
  let display = text;
  for (const m of text.matchAll(ACTION_RE)) {
    const [, type, arg] = m;
    if (type === "pause-agent" && arg) actions.push({ type, slot: arg.trim() });
    else if (type === "resume-agent" && arg) actions.push({ type, slot: arg.trim() });
    else if (type === "pause-fleet") actions.push({ type });
    else if (type === "resume-fleet") actions.push({ type });
  }
  display = display.replace(ACTION_RE, "").replace(/\n{3,}/g, "\n\n").trim();
  return { display, actions };
}

/** Map a wavex slot ("cmo.demand") to its Paperclip urlKey ("cmo-demand"). */
function slotToUrlKey(slot: string): string {
  return slot.replace(/\./g, "-");
}

// ── Char-by-char reveal for the newest assistant message ──────────────

const REVEAL_CHARS_PER_SEC = 240; // ~3.5s for an 800-char reply, snappy

function StreamingMarkdown({ text, onDone }: { text: string; onDone?: () => void }) {
  const [shown, setShown] = useState(0);
  const onDoneRef = useRef(onDone);
  useEffect(() => { onDoneRef.current = onDone; }, [onDone]);

  useEffect(() => {
    setShown(0);
    if (!text) return;
    const startedAt = performance.now();
    let raf = 0;
    let done = false;
    const tick = (now: number) => {
      const elapsed = (now - startedAt) / 1000;
      const next = Math.min(text.length, Math.floor(elapsed * REVEAL_CHARS_PER_SEC));
      setShown(next);
      if (next < text.length) raf = requestAnimationFrame(tick);
      else if (!done) { done = true; onDoneRef.current?.(); }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  return (
    <div className="prose prose-sm dark:prose-invert max-w-none [&>*]:my-1">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {text.slice(0, shown)}
      </ReactMarkdown>
      {shown < text.length && <span className="opacity-50">▌</span>}
    </div>
  );
}

function StaticMarkdown({ text }: { text: string }) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none [&>*]:my-1">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────

export function BoardChat() {
  const { selectedCompanyId, companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const location = useLocation();
  const selectedCompany = companies.find((c) => c.id === selectedCompanyId) ?? null;
  const wavexId = deriveWavexCompanyId(selectedCompany);
  const [draft, setDraft] = useState("");
  // Persist which assistant messages have already finished their char-by-char
  // reveal so navigating away + back doesn't replay the animation. Keyed by
  // wavex company id; lives in sessionStorage (cleared with the tab, which is
  // fine — the animation only matters relative to the operator's last view).
  const revealedStorageKey = useMemo(
    () => (wavexId ? `kernel:revealed:${wavexId}` : "kernel:revealed:none"),
    [wavexId],
  );
  const [revealedIds, setRevealedIds] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const raw = window.sessionStorage.getItem(revealedStorageKey);
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    try {
      window.sessionStorage.setItem(
        revealedStorageKey,
        JSON.stringify(Array.from(revealedIds)),
      );
    } catch {
      // sessionStorage quota / disabled — silently drop persistence; the
      // animation just replays on remount, which is the pre-fix behavior.
    }
  }, [revealedIds, revealedStorageKey]);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const qc = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Kernel" }]);
  }, [setBreadcrumbs]);

  const chatQ = useQuery({
    enabled: !!wavexId,
    queryKey: ["wavex-board-chat", wavexId],
    queryFn: () => wavexApi.getBoardChat(wavexId!),
    retry: false,
  });

  // Live Paperclip agent list for slot→agentId resolution on action buttons
  const agentsQ = useQuery({
    enabled: !!selectedCompanyId,
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
  });
  const urlKeyToAgentId = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agentsQ.data ?? []) {
      if (a.urlKey) m.set(a.urlKey, a.id);
    }
    return m;
  }, [agentsQ.data]);

  const send = useMutation({
    mutationFn: (message: string) => wavexApi.postBoardChat(wavexId!, message, location.pathname),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wavex-board-chat", wavexId] });
      setDraft("");
    },
  });

  // Action mutations — wired to existing Paperclip routes
  const pauseAgent = useMutation({
    mutationFn: (slot: string) => {
      const id = urlKeyToAgentId.get(slotToUrlKey(slot));
      if (!id) throw new Error(`No Paperclip agent matches slot ${slot}`);
      return agentsApi.pause(id, selectedCompanyId ?? undefined);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) });
      qc.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId!) });
    },
  });
  const resumeAgent = useMutation({
    mutationFn: (slot: string) => {
      const id = urlKeyToAgentId.get(slotToUrlKey(slot));
      if (!id) throw new Error(`No Paperclip agent matches slot ${slot}`);
      return agentsApi.resume(id, selectedCompanyId ?? undefined);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) });
      qc.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId!) });
    },
  });
  const pauseFleet = useMutation({
    mutationFn: () => agentsApi.pauseFleet(selectedCompanyId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) });
      qc.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId!) });
    },
  });
  const resumeFleet = useMutation({
    mutationFn: () => agentsApi.resumeFleet(selectedCompanyId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) });
      qc.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId!) });
    },
  });
  const anyActionPending = pauseAgent.isPending || resumeAgent.isPending || pauseFleet.isPending || resumeFleet.isPending;

  // Auto-scroll on new message + while a reply streams
  useEffect(() => {
    if (!scrollerRef.current) return;
    scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  }, [chatQ.data?.messages?.length, send.isPending]);

  if (!wavexId) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md text-center">
          <MessageCircle className="mx-auto h-8 w-8 text-muted-foreground/60 mb-3" />
          <h2 className="text-base font-semibold mb-1">Kernel is wavex-only</h2>
          <p className="text-sm text-muted-foreground">
            Companies onboarded through wavex-os get the Kernel chat — a
            board-level lens into the live fleet. This Paperclip company isn't
            wavex-onboarded.
          </p>
        </div>
      </div>
    );
  }

  const messages = chatQ.data?.messages ?? [];
  const networkDown = chatQ.error instanceof WavexFetchError;
  const lastAssistantIdx = (() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant") return i;
    return -1;
  })();

  function runAction(action: ParsedAction) {
    if (action.type === "pause-agent") pauseAgent.mutate(action.slot);
    else if (action.type === "resume-agent") resumeAgent.mutate(action.slot);
    else if (action.type === "pause-fleet") pauseFleet.mutate();
    else if (action.type === "resume-fleet") resumeFleet.mutate();
  }

  function actionLabel(action: ParsedAction): string {
    switch (action.type) {
      case "pause-agent": return `Pause ${action.slot}`;
      case "resume-agent": return `Resume ${action.slot}`;
      case "pause-fleet": return "Pause fleet";
      case "resume-fleet": return "Resume fleet";
    }
  }

  function actionIcon(action: ParsedAction) {
    if (action.type === "pause-agent" || action.type === "pause-fleet") {
      return <PauseCircle className="h-3.5 w-3.5" />;
    }
    return <PlayCircle className="h-3.5 w-3.5" />;
  }

  function isDestructive(action: ParsedAction): boolean {
    return action.type === "pause-agent" || action.type === "pause-fleet";
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-6 py-3 shrink-0">
        <MessageCircle className="h-4 w-4 text-muted-foreground" />
        <h1 className="text-sm font-semibold">Kernel</h1>
        <span className="text-xs text-muted-foreground">
          Grounded in live fleet state · ask anything
        </span>
      </div>

      <div ref={scrollerRef} className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
        <div className="mx-auto max-w-3xl space-y-3">
          {networkDown && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-100">
              wavex core (port 3101) is unreachable. Chat won't work until it's back.
            </div>
          )}
          {!networkDown && messages.length === 0 && !chatQ.isLoading && (
            <div className="rounded-lg border bg-card p-4">
              <p className="text-sm text-muted-foreground mb-3">
                Ask Kernel anything about the fleet. Try one of these:
              </p>
              <div className="flex flex-wrap gap-2">
                {[
                  "What's the most important thing right now?",
                  "Anything broken or stuck?",
                  "Where is growth coming from?",
                ].map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => { setDraft(q); send.mutate(q); }}
                    className="rounded-full border bg-background px-3 py-1.5 text-xs hover:bg-muted"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => {
            if (m.role === "user") {
              return (
                <div
                  key={i}
                  className="ml-auto max-w-[85%] rounded-2xl rounded-br-md border border-sky-500/25 bg-sky-500/10 px-3.5 py-2.5 text-sm whitespace-pre-wrap text-foreground"
                >
                  {m.text}
                </div>
              );
            }
            const { display, actions } = parseMessage(m.text);
            const isNewest = i === lastAssistantIdx;
            const msgKey = `${m.ts_iso}:${i}`;
            const alreadyRevealed = revealedIds.has(msgKey);
            return (
              <div
                key={i}
                className="mr-auto max-w-[85%] rounded-lg border-l-2 border-emerald-500/50 bg-muted px-3.5 py-2.5 text-sm"
              >
                {isNewest && !alreadyRevealed ? (
                  <StreamingMarkdown
                    text={display}
                    onDone={() => setRevealedIds((prev) => {
                      const next = new Set(prev);
                      next.add(msgKey);
                      return next;
                    })}
                  />
                ) : (
                  <StaticMarkdown text={display} />
                )}
                {actions.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-border/60 pt-2.5">
                    {actions.map((a, idx) => (
                      <button
                        key={idx}
                        type="button"
                        disabled={anyActionPending}
                        onClick={() => runAction(a)}
                        className={
                          isDestructive(a)
                            ? "inline-flex items-center gap-1.5 rounded-md border border-rose-500/40 bg-rose-500/5 px-2.5 py-1 text-xs font-medium text-rose-100 hover:bg-rose-500/15 disabled:opacity-50"
                            : "inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/5 px-2.5 py-1 text-xs font-medium text-emerald-200 hover:bg-emerald-500/15 disabled:opacity-50"
                        }
                      >
                        {actionIcon(a)}
                        {actionLabel(a)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {send.isPending && (
            <div className="mr-auto max-w-[85%] rounded-lg border-l-2 border-emerald-500/50 bg-muted px-3.5 py-2.5 text-sm text-muted-foreground">
              <span className="inline-block animate-pulse">…</span>
            </div>
          )}
          {(pauseAgent.error || resumeAgent.error || pauseFleet.error || resumeFleet.error) && (
            <div className="mr-auto max-w-[85%] rounded-md border border-rose-500/40 bg-rose-500/5 px-3 py-2 text-xs text-rose-200">
              Action failed: {
                (pauseAgent.error as Error | undefined)?.message
                ?? (resumeAgent.error as Error | undefined)?.message
                ?? (pauseFleet.error as Error | undefined)?.message
                ?? (resumeFleet.error as Error | undefined)?.message
              }
            </div>
          )}
        </div>
      </div>

      <form
        className="border-t p-3 shrink-0"
        onSubmit={(e) => {
          e.preventDefault();
          const text = draft.trim();
          if (!text || send.isPending) return;
          send.mutate(text);
        }}
      >
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                const text = draft.trim();
                if (text && !send.isPending) send.mutate(text);
              }
            }}
            rows={1}
            placeholder={send.isPending ? "Thinking…" : "Ask anything…"}
            disabled={send.isPending || networkDown}
            className="flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            type="submit"
            disabled={!draft.trim() || send.isPending || networkDown}
            className="rounded-md bg-primary p-2 text-primary-foreground hover:opacity-90 disabled:opacity-40"
            aria-label="Send"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </form>
    </div>
  );
}
