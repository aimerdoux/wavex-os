/** @wavex-os/shared — cross-package primitives.
 *
 *  Current contents:
 *    - types/mission-control     Universal accountability model (Task,
 *                                Deliverable, ScopeNode, ActivityEvent, KPI,
 *                                ExpectedKpiImpact, ChiefOfStaffConfig)
 *    - schemas/mission-control   Zod runtime validators for the above
 *
 *  Future home for Avatar v2.1 charter types once that work returns to
 *  the queue (see ~/.claude/plans/sharded-roaming-naur.md for sequencing).
 */

export * from "./types/mission-control.js";
export * as schemas from "./schemas/mission-control.js";
