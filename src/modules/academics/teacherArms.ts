import { logger } from '../../common/utils/logger';
import type { KeyValueStore } from '../auth/keyValueStore';
import type { assignmentRepository } from './assignment.repository';
import type { sessionRepository } from './session.repository';
import type { structureRepository } from './structure.repository';

const TTL_SECONDS = 10 * 60;

interface Entry { teaches: string[]; classTeacherOf: string[] }
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

export function createTeacherArmsCache(deps: {
  store: KeyValueStore;
  assignments: Pick<typeof assignmentRepository, 'armIdsOfTeacher'>;
  structure: Pick<typeof structureRepository, 'armIdsOfClassTeacher'>;
  sessions: Pick<typeof sessionRepository, 'findCurrentSession'>;
}) {
  const key = (sessionId: string, teacherId: string) => `ta:${sessionId}:${teacherId}`;

  async function load(teacherId: string): Promise<Entry> {
    const current = await deps.sessions.findCurrentSession();
    if (!current) return { teaches: [], classTeacherOf: [] };
    const k = key(current.id, teacherId);

    try {
      const raw = await deps.store.get(k);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && 'teaches' in parsed && 'classTeacherOf' in parsed && isStringArray(parsed.teaches) && isStringArray(parsed.classTeacherOf)) {
          return { teaches: parsed.teaches, classTeacherOf: parsed.classTeacherOf };
        }
      }
    } catch {
      // Redis is down or the entry is damaged: read from MongoDB instead.
    }

    const [teaches, classTeacherOf] = await Promise.all([
      deps.assignments.armIdsOfTeacher(teacherId, current.id),
      deps.structure.armIdsOfClassTeacher(teacherId),
    ]);
    const entry = { teaches, classTeacherOf };
    try {
      await deps.store.setMany([{ key: k, value: JSON.stringify(entry), ttlSeconds: TTL_SECONDS }]);
    } catch {
      // The cache is an optimisation only.
    }
    return entry;
  }

  return {
    /** Every class arm this teacher teaches or is class teacher of, this session. */
    async armIdsOf(teacherId: string): Promise<string[]> {
      const entry = await load(teacherId);
      return [...new Set([...entry.teaches, ...entry.classTeacherOf])];
    },
    async classTeacherArmIdsOf(teacherId: string): Promise<string[]> {
      return (await load(teacherId)).classTeacherOf;
    },
    /** Called whenever an admin changes assignments or class teachers. */
    async invalidate(teacherId: string): Promise<void> {
      try {
        const current = await deps.sessions.findCurrentSession();
        if (current) await deps.store.delete(key(current.id, teacherId));
      } catch (err) {
        logger.warn({ err }, 'teacher arms cache could not be cleared; it will expire on its own');
      }
    },
  };
}

export type TeacherArmsCache = ReturnType<typeof createTeacherArmsCache>;