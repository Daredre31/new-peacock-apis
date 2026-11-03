import type { KeyValueStore } from '../auth/keyValueStore';
import type { PaperQuestion } from './grading';
import type { questionRepository } from './question.repository';

export function createPaperCache(deps: { store: KeyValueStore; questions: Pick<typeof questionRepository, 'paperOf'> }) {
  const key = (examId: string): string => `cbt:paper:${examId}`;

  return {
    /** The question paper without answers. Redis first, MongoDB if Redis is empty or down. */
    async get(exam: { id: string; windowEnd: Date }): Promise<PaperQuestion[]> {
      try {
        const raw = await deps.store.get(key(exam.id));
        if (raw) {
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed)) return parsed as PaperQuestion[];
        }
      } catch {
        // Redis down or entry damaged: read from MongoDB.
      }
      const paper = await deps.questions.paperOf(exam.id);
      try {
        const seconds = Math.floor((exam.windowEnd.getTime() - Date.now()) / 1000) + 2 * 60 * 60;
        await deps.store.setMany([{ key: key(exam.id), value: JSON.stringify(paper), ttlSeconds: Math.min(7 * 86_400, Math.max(600, seconds)) }]);
      } catch {
        // The cache is an optimisation only.
      }
      return paper;
    },
    async invalidate(examId: string): Promise<void> {
      try { await deps.store.delete(key(examId)); } catch { /* it expires on its own */ }
    },
  };
}

export type PaperCache = ReturnType<typeof createPaperCache>;