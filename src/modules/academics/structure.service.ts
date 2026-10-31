import { AppError } from '../../common/errors/AppError';
import { isDuplicateKeyError } from '../../common/utils/mongoErrors';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import {
  structureRepository as repo,
  type ArmRecord,
  type ArmSort,
  // type ClassRecord,
  type ClassSort,
  type SubjectRecord,
  type SubjectSort,
} from './structure.repository';

interface Actor { id: string }
interface Context { ip: string; requestId: string }
interface Page<S> { page: number; limit: number; sort: S }

const fail = (field: string, issue: string): AppError =>
  new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });

const assertNotEmpty = (patch: object): void => {
  if (Object.keys(patch).length === 0) throw fail('body', 'Nothing to update');
};

/** A unique-index violation becomes a CONFLICT with a message that says what clashed. */
async function guarded<T>(work: () => Promise<T>, message: string): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (isDuplicateKeyError(err)) throw new AppError('CONFLICT', { message, cause: err });
    throw err;
  }
}

const armView = (arm: ArmRecord, className: string) => ({
  id: arm.id,
  classId: arm.classId,
  className,
  name: arm.name,
  displayName: `${className} ${arm.name}`,
  classTeacherId: arm.classTeacherId,
});
export type ArmView = ReturnType<typeof armView>;

export function createStructureService(deps: { audit: AuditPort }) {
  const log = (
    action: string,
    entityType: 'class' | 'classArm' | 'subject',
    actor: Actor,
    ctx: Context,
    entityId: string,
    before: object | null,
    after: object | null,
  ) =>
    recordSafely(deps.audit, {
      action,
      actorId: actor.id,
      entityType,
      entityId,
      ip: ctx.ip,
      requestId: ctx.requestId,
      before: before as Record<string, unknown> | null,
      after: after as Record<string, unknown> | null,
    });

  async function assertSubjectsExist(ids: string[]): Promise<string[]> {
    const unique = [...new Set(ids)];
    if (unique.length > 0 && (await repo.countExistingSubjects(unique)) !== unique.length) {
      throw fail('subjectIds', 'One or more subjects do not exist');
    }
    return unique;
  }

  async function armsWithClassNames(arms: ArmRecord[]): Promise<ArmView[]> {
    const classes = await repo.classesByIds(arms.map((a) => a.classId));
    return arms.map((arm) => armView(arm, classes.get(arm.classId)?.name ?? ''));
  }

  return {
    // ---- classes
    listClasses: (input: Page<ClassSort> & { q?: string }) => {
      const { page, limit, sort, ...filter } = input;
      return repo.listClasses(filter, { page, limit, sort });
    },

    async createClass(input: { name: string; level: number; subjectIds?: string[] }, actor: Actor, ctx: Context) {
      const subjectIds = await assertSubjectsExist(input.subjectIds ?? []);
      const created = await guarded(
        () => repo.createClass({ name: input.name, level: input.level, subjectIds }),
        'A class with this name or level already exists',
      );
      await log('CLASS_CREATED', 'class', actor, ctx, created.id, null, created);
      return created;
    },

    async updateClass(
      id: string,
      patch: Partial<{ name: string; level: number; subjectIds: string[] }>,
      actor: Actor,
      ctx: Context,
    ) {
      assertNotEmpty(patch);
      const before = await repo.findClass(id);
      if (!before) throw new AppError('NOT_FOUND');

      const next = { ...patch, ...(patch.subjectIds && { subjectIds: await assertSubjectsExist(patch.subjectIds) }) };
      const after = await guarded(() => repo.updateClass(id, next), 'A class with this name or level already exists');
      if (!after) throw new AppError('NOT_FOUND');

      await log('CLASS_UPDATED', 'class', actor, ctx, id, before, after);
      return after;
    },

    // ---- class arms
    async listArms(input: Page<ArmSort> & { classId?: string; q?: string }) {
      const { page, limit, sort, ...filter } = input;
      const { items, total } = await repo.listArms(filter, { page, limit, sort });
      return { items: await armsWithClassNames(items), total };
    },

    async createArm(input: { classId: string; name: string }, actor: Actor, ctx: Context): Promise<ArmView> {
      const parent = await repo.findClass(input.classId);
      if (!parent) throw fail('classId', 'Class not found');

      const created = await guarded(() => repo.createArm(input), 'This class already has an arm with that name');
      const view = armView(created, parent.name);
      await log('CLASS_ARM_CREATED', 'classArm', actor, ctx, created.id, null, view);
      return view;
    },

    async updateArm(id: string, patch: { name: string }, actor: Actor, ctx: Context): Promise<ArmView> {
      const before = await repo.findArm(id);
      if (!before) throw new AppError('NOT_FOUND');

      const after = await guarded(() => repo.updateArm(id, patch), 'This class already has an arm with that name');
      if (!after) throw new AppError('NOT_FOUND');

      const [view] = await armsWithClassNames([after]);
      if (!view) throw new AppError('NOT_FOUND');
      await log('CLASS_ARM_UPDATED', 'classArm', actor, ctx, id, before, view);
      return view;
    },

    // ---- subjects
    listSubjects: (input: Page<SubjectSort> & { q?: string }) => {
      const { page, limit, sort, ...filter } = input;
      return repo.listSubjects(filter, { page, limit, sort });
    },

    async createSubject(input: { name: string; code: string }, actor: Actor, ctx: Context): Promise<SubjectRecord> {
      const data = { name: input.name, code: input.code.toUpperCase() };
      const created = await guarded(() => repo.createSubject(data), 'A subject with this name or code already exists');
      await log('SUBJECT_CREATED', 'subject', actor, ctx, created.id, null, created);
      return created;
    },

    async updateSubject(id: string, patch: Partial<{ name: string; code: string }>, actor: Actor, ctx: Context) {
      assertNotEmpty(patch);
      const before = await repo.findSubject(id);
      if (!before) throw new AppError('NOT_FOUND');

      const next = { ...patch, ...(patch.code && { code: patch.code.toUpperCase() }) };
      const after = await guarded(() => repo.updateSubject(id, next), 'A subject with this name or code already exists');
      if (!after) throw new AppError('NOT_FOUND');

      await log('SUBJECT_UPDATED', 'subject', actor, ctx, id, before, after);
      return after;
    },
  };
}

export type StructureService = ReturnType<typeof createStructureService>;