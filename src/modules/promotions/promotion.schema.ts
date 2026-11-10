import { z } from 'zod';
import { PERMISSIONS } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';

const objectId = z.string().regex(/^[a-f0-9]{24}$/);

export const previewQuery = z.object({
  /** The class arm being promoted, and the session that is ending. */
  classArmId: objectId, sessionId: objectId,
  /** The session students move into. */
  targetSessionId: objectId,
  /** Only needed when the next class has no arm with the same name. */
  targetArmId: objectId.optional(),
});
export const previewSchemas = { query: previewQuery };

export function registerPromotionOperations(registry: OpenApiRegistry): void {
  const tags = ['promotions'];
  const num = z.number().int();
  const named = z.object({ id: z.string(), name: z.string() });
  const outcome = z.enum(['PROMOTE', 'REPEAT', 'GRADUATE', 'NEEDS_DECISION', 'ALREADY_ENROLLED', 'NOT_ELIGIBLE']);
  const reason = z.enum(['INCOMPLETE_RESULTS', 'OWES_FEES', 'NOT_ACTIVE', 'ALREADY_ENROLLED']);

  registry.register({
    method: 'get', path: '/promotions/preview', operationId: 'previewPromotion',
    summary: 'What would happen to each student in a class when moving to the next session. A yearly average at or above the pass mark promotes (or graduates from the top class), below it repeats. Owing fees blocks a promotion or graduation. Incomplete results need a decision. Writes nothing',
    tags, roles: PERMISSIONS['promotions:preview'], request: { query: previewQuery },
    success: {
      status: 200, description: 'The preview',
      data: z.object({
        passMarkPercent: num,
        source: z.object({ session: named, classArm: named, termsClosed: z.boolean() }),
        target: z.object({ session: named, nextClass: z.object({ id: z.string(), name: z.string(), level: num }).nullable(), arm: named.nullable(), isFinalClass: z.boolean() }),
        issues: z.array(z.object({ code: z.enum(['TARGET_SESSION_NOT_AFTER_SOURCE', 'TERMS_NOT_CLOSED', 'TARGET_ARM_MISSING', 'NO_STUDENTS']), message: z.string() })),
        summary: z.object({ promote: num, repeat: num, graduate: num, needsDecision: num, alreadyEnrolled: num, notEligible: num, blockedByFees: num }),
        students: z.array(z.object({
          studentId: z.string(), name: z.string(), admissionNo: z.string(), average: z.number().nullable(), grade: z.string().nullable(),
          position: num.nullable(), complete: z.boolean(), outcome, blocked: z.boolean(), reasons: z.array(reason), owingKobo: num,
        })),
      }),
    },
    errors: ['NOT_FOUND'],
  });
}
