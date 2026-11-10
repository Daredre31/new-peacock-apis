import type { StudentStatus } from '../users/student.model';

export const OUTCOME = {
  PROMOTE: 'PROMOTE', REPEAT: 'REPEAT', GRADUATE: 'GRADUATE',
  NEEDS_DECISION: 'NEEDS_DECISION', ALREADY_ENROLLED: 'ALREADY_ENROLLED', NOT_ELIGIBLE: 'NOT_ELIGIBLE',
} as const;
export type Outcome = (typeof OUTCOME)[keyof typeof OUTCOME];

export const REASON = {
  INCOMPLETE_RESULTS: 'INCOMPLETE_RESULTS', OWES_FEES: 'OWES_FEES', NOT_ACTIVE: 'NOT_ACTIVE', ALREADY_ENROLLED: 'ALREADY_ENROLLED',
} as const;
export type Reason = (typeof REASON)[keyof typeof REASON];

export interface StudentFacts {
  /** Null when the student has no active record (missing or deleted). */
  status: StudentStatus | null;
  /** Already has an enrolment in the target session, so there is nothing left to do. */
  alreadyEnrolled: boolean;
  average: number | null;
  /** Published results in every term of the session. */
  complete: boolean;
  owingKobo: number;
}
export interface PromotionRules { passMarkPercent: number; isFinalClass: boolean }
export interface Decision { outcome: Outcome; blocked: boolean; reasons: Reason[] }

/**
 * What should happen to one student. Pure: it only reads its inputs.
 * Passing moves up (or graduates from the top class), failing repeats, anything uncertain waits for a person.
 * Owing fees BLOCKS a promotion or graduation. It never blocks repeating, because that is not a promotion.
 */
export function decide(facts: StudentFacts, rules: PromotionRules): Decision {
  if (facts.status !== 'ACTIVE') return { outcome: OUTCOME.NOT_ELIGIBLE, blocked: false, reasons: [REASON.NOT_ACTIVE] };
  if (facts.alreadyEnrolled) return { outcome: OUTCOME.ALREADY_ENROLLED, blocked: false, reasons: [REASON.ALREADY_ENROLLED] };

  const reasons: Reason[] = facts.owingKobo > 0 ? [REASON.OWES_FEES] : [];
  if (!facts.complete || facts.average === null) {
    return { outcome: OUTCOME.NEEDS_DECISION, blocked: false, reasons: [REASON.INCOMPLETE_RESULTS, ...reasons] };
  }

  const outcome = facts.average >= rules.passMarkPercent ? (rules.isFinalClass ? OUTCOME.GRADUATE : OUTCOME.PROMOTE) : OUTCOME.REPEAT;
  return { outcome, blocked: outcome !== OUTCOME.REPEAT && facts.owingKobo > 0, reasons };
}
