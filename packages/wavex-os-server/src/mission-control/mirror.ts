/** Mirror a wavex-side activity into the Mission Control ledger.
 *
 *  Existing runners already POST a Paperclip-side activity entry; this
 *  helper sits alongside that call (best-effort, never throws back to the
 *  runner) so the Mission Control stream surfaces the same event. The
 *  action string is translated via `actionToEventKind()`; unmapped actions
 *  are silently skipped — Phase 1 widgets fall back to a generic sentence
 *  for them anyway, but mirroring noise into the wavex DB has no value.
 *
 *  Runners pass through:
 *    - companyId / instanceId (the Paperclip company is the same id we use
 *      as instanceId in the MC ledger, per the Phase 0 ScopeTree mapping)
 *    - actorNodeId (avatar id, agent id, or "system")
 *    - subjectRef (loose JSONB blob the renderer reads)
 *    - optional taskRef / kpiRef / deliverableRef + costUSD + plain
 *      sentence (skip rendering server-side; the widget renders).
 *
 *  Failures are logged but swallowed — a Mission Control mirror error
 *  must never break the underlying runner work. */

import type {
  ActivityEvent,
  PaperclipMode,
  SubjectRef,
  TaskRef,
  KpiRef,
  DeliverableRef,
} from "@wavex-os/shared/types/mission-control";
import { actionToEventKind } from "./event-kind-map.js";
import { logMissionControlActivity } from "./activity-log.js";

export interface MirrorMissionControlInput {
  companyId: string;
  instanceId?: string;
  modeContext?: PaperclipMode;
  actorNodeId: string;
  action: string;
  subjectRef?: SubjectRef;
  scopeChain?: string[];
  taskRef?: TaskRef;
  kpiRef?: KpiRef;
  deliverableRef?: DeliverableRef;
  costUSD?: number;
  expectedImpact?: string;
  plainLanguageSentence?: string;
  severity?: ActivityEvent["severity"];
  detailUrl?: string;
}

export async function mirrorToMissionControl(
  input: MirrorMissionControlInput,
): Promise<void> {
  const kind = actionToEventKind(input.action);
  if (!kind) return;
  try {
    await logMissionControlActivity({
      companyId: input.companyId,
      instanceId: input.instanceId ?? input.companyId,
      kind,
      modeContext: input.modeContext ?? "solo_founder",
      actorNodeId: input.actorNodeId,
      action: input.action,
      subjectRef: input.subjectRef ?? { kind: "generic" },
      scopeChain: input.scopeChain,
      taskRef: input.taskRef,
      kpiRef: input.kpiRef,
      deliverableRef: input.deliverableRef,
      costUSD: input.costUSD,
      expectedImpact: input.expectedImpact,
      plainLanguageSentence: input.plainLanguageSentence,
      severity: input.severity,
      detailUrl: input.detailUrl,
    });
  } catch {
    // Best-effort mirror. A failure here must not break the runner.
  }
}
