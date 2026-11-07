import type { RequestType } from './request.payloads';

export interface RequestCheckInput { payload: Record<string, unknown>; studentId: string | null }
export type RequestCheck = (input: RequestCheckInput) => Promise<void>;

export function createRequestChecks() {
  const checks = new Map<RequestType, RequestCheck>();
  return {
    register(type: RequestType, check: RequestCheck): void {
      checks.set(type, check);
    },
    async run(type: RequestType, input: RequestCheckInput): Promise<void> {
      await checks.get(type)?.(input);
    },
  };
}
export type RequestChecks = ReturnType<typeof createRequestChecks>;