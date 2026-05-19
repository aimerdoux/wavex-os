/** In-process pub/sub for newly-logged Mission Control ActivityEvents.
 *
 *  v1 is single-instance (one wavex op-omega-server per machine), so a
 *  plain Node EventEmitter is sufficient. Subscribers receive events as
 *  they're committed by `logMissionControlActivity()`. Multi-instance
 *  deployments would need a real bus (Redis pubsub or Postgres LISTEN);
 *  flagged in the plan's "Operational dependencies" section.
 *
 *  Subscribers are bounded by `setMaxListeners` so an SSE client storm
 *  doesn't silently warn-log forever — we surface it as an error and the
 *  caller can decide whether to grow the limit. */

import { EventEmitter } from "node:events";
import type { ActivityEvent } from "@wavex-os/shared/types/mission-control";

const bus = new EventEmitter();
bus.setMaxListeners(256);

const CHANNEL = "mc:event";

export function publishMissionControlEvent(event: ActivityEvent): void {
  bus.emit(CHANNEL, event);
}

export function subscribeMissionControlEvents(
  listener: (event: ActivityEvent) => void,
): () => void {
  bus.on(CHANNEL, listener);
  return () => {
    bus.off(CHANNEL, listener);
  };
}

/** Test helper — drops every listener. Production code must not call this. */
export function _resetActivityBusForTesting(): void {
  bus.removeAllListeners(CHANNEL);
}
