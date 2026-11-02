import { logger } from '../../common/utils/logger';
import type { DecisionOutcome } from './request.rules';
import type { RequestType } from './request.payloads';

export interface RequestDecidedEvent {
  requestId: string;
  reference: string;
  type: RequestType;
  outcome: DecisionOutcome;
  studentId: string | null;
  payload: Record<string, unknown>;
  createdBy: string;
  decidedBy: string;
  at: Date;
}

export function createRequestEvents() {
  const handlers = new Set<(event: RequestDecidedEvent) => Promise<void>>();
  return {
    onDecided(handler: (event: RequestDecidedEvent) => Promise<void>): void {
      handlers.add(handler);
    },
    /** A failing handler is logged and never blocks the decision or the other handlers. */
    async emitDecided(event: RequestDecidedEvent): Promise<void> {
      for (const handler of handlers) {
        try {
          await handler(event);
        } catch (err) {
          logger.error({ err, requestId: event.requestId, type: event.type }, 'request event handler failed');
        }
      }
    },
  };
}

export type RequestEvents = ReturnType<typeof createRequestEvents>;