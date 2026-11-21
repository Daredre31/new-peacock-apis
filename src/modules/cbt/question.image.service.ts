import { AppError } from '../../common/errors/AppError';
import { detectImageType, fitWithin, normalizeImageFileName, readDimensions } from '../../common/utils/image';
import { logger } from '../../common/utils/logger';
import { withTransaction } from '../../config/db';
import type { ImageStore } from '../../integrations/imageStore';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import { EXAM_STATUS } from './cbt.types';
import type { ExamRecord, examRepository } from './exam.repository';
import type { PaperCache } from './paper.cache';
import type { questionImageRepository, ImageRecord } from './question.image.repository';
import type { questionRepository } from './question.repository';

export const MAX_IMAGES_PER_EXAM = 200;
/** What a picture may measure before it is refused: stops a tiny speck or a huge pixel-bomb reaching the image store. */
const MIN_SIDE = 20;
const MAX_SIDE = 10_000;
const MAX_PIXELS = 40_000_000;
const DELIVERED_MAX_SIDE = 1600;

interface Actor { id: string }
interface Context { ip: string; requestId: string }

export interface ImageView {
  fileName: string; url: string; width: number; height: number; bytes: number;
  /** The questions showing this picture. Empty until it is attached to one. */
  questionIds: string[];
  uploadedAt: string;
}

const invalid = (field: string, issue: string): AppError => new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });
const publicIdOf = (examId: string, fileName: string): string => `cbt/${examId}/${fileName.replace(/\./g, '-')}`;

export function createQuestionImageService(deps: {
  images: ImageStore;
  library: typeof questionImageRepository;
  questions: Pick<typeof questionRepository, 'hasQuestion' | 'attachImage' | 'refreshImage' | 'clearImage' | 'imageLinks'>;
  exams: Pick<typeof examRepository, 'findById'>;
  paper: PaperCache;
  audit: AuditPort;
}) {
  const { images, library, questions, exams, paper, audit } = deps;

  /** The teacher's own exam. Changing pictures is only allowed while questions can still be changed. */
  async function ownedExam(actor: Actor, examId: string, mustBeEditable: boolean): Promise<ExamRecord> {
    const exam = await exams.findById(examId);
    if (!exam || exam.teacherId !== actor.id) throw new AppError('NOT_FOUND');
    if (mustBeEditable && exam.status !== EXAM_STATUS.DRAFT && exam.status !== EXAM_STATUS.REJECTED) {
      throw new AppError('CONFLICT', { message: 'Only a draft or a rejected exam can have its pictures changed' });
    }
    return exam;
  }

  const toView = (record: ImageRecord, links: Map<string, string[]>): ImageView => ({
    fileName: record.fileName, url: record.url, width: record.width, height: record.height, bytes: record.bytes,
    questionIds: links.get(record.fileName) ?? [], uploadedAt: record.uploadedAt.toISOString(),
  });

  return {
    async list(actor: Actor, examId: string): Promise<ImageView[]> {
      await ownedExam(actor, examId, false);
      const [records, links] = await Promise.all([library.listForExam(examId), questions.imageLinks(examId)]);
      return records.map((r) => toView(r, links));
    },

    /**
     * Adds a picture to the exam's library, and ties it to a question if questionId is given. Uploading the same file name
     * again replaces the picture everywhere it is used. A spreadsheet's image column finds pictures by this name.
     */
    async upload(actor: Actor, examId: string, input: { originalName: string; buffer: Buffer; questionId?: string | undefined }, ctx: Context): Promise<ImageView> {
      await ownedExam(actor, examId, true);

      const fileName = normalizeImageFileName(input.originalName);
      if (!fileName) throw invalid('file', 'Name the file with letters, numbers, dots or dashes, ending in .png, .jpg or .jpeg. For example triangle.png');
      // The type comes from the file's own bytes: the name and the Content-Type header are only what the client claims.
      const type = detectImageType(input.buffer);
      if (type !== 'png' && type !== 'jpeg') throw invalid('file', 'Only PNG and JPG pictures are accepted');
      const size = readDimensions(input.buffer);
      if (!size) throw invalid('file', 'This picture could not be read. Save it again as a PNG or JPG');
      if (size.width < MIN_SIDE || size.height < MIN_SIDE) throw invalid('file', `The picture is too small. Each side must be at least ${MIN_SIDE} pixels`);
      if (size.width > MAX_SIDE || size.height > MAX_SIDE || size.width * size.height > MAX_PIXELS) throw invalid('file', 'The picture is too large. Reduce its size and try again');

      if (input.questionId !== undefined && !(await questions.hasQuestion(examId, input.questionId))) {
        throw invalid('questionId', 'This exam has no such question');
      }
      const existing = await library.find(examId, fileName);
      if (!existing && (await library.count(examId)) >= MAX_IMAGES_PER_EXAM) {
        throw new AppError('CONFLICT', { details: [{ field: 'file', issue: `An exam can have at most ${MAX_IMAGES_PER_EXAM} pictures` }] });
      }

      const publicId = publicIdOf(examId, fileName);
      const stored = await images.upload(input.buffer, publicId, 'question');
      // The store reports the delivered size. If it does not, work it out: the same shrink rule applies.
      const delivered = stored.width && stored.height ? { width: stored.width, height: stored.height } : fitWithin(size.width, size.height, DELIVERED_MAX_SIDE);

      const saved = await withTransaction(async (tx) => {
        const record = await library.save({ examId, fileName, publicId, url: stored.url, width: delivered.width, height: delivered.height, bytes: input.buffer.length, uploadedBy: actor.id }, tx);
        const fields = { fileName, url: record.url, width: record.width, height: record.height };
        if (existing) await questions.refreshImage(examId, fields, tx);
        if (input.questionId !== undefined && !(await questions.attachImage(examId, input.questionId, fields, tx))) {
          throw invalid('questionId', 'This exam has no such question');
        }
        return record;
      });

      await paper.invalidate(examId);
      await recordSafely(audit, {
        action: 'EXAM_IMAGE_UPLOADED', actorId: actor.id, entityType: 'exam', entityId: examId, ip: ctx.ip, requestId: ctx.requestId,
        metadata: { fileName, bytes: input.buffer.length, questionId: input.questionId ?? null, replaced: existing !== null },
      });
      return toView(saved, await questions.imageLinks(examId));
    },

    /**
     * Removes the picture from the image store first. If the store is down nothing changes, so the exam never points at a
     * picture that still exists. Then every question that showed it is cleared.
     */
    async remove(actor: Actor, examId: string, rawFileName: string, ctx: Context): Promise<void> {
      await ownedExam(actor, examId, true);
      const fileName = normalizeImageFileName(rawFileName);
      const record = fileName ? await library.find(examId, fileName) : null;
      if (!fileName || !record) throw new AppError('NOT_FOUND');

      await images.remove(record.publicId);
      await withTransaction(async (tx) => {
        await library.remove(examId, fileName, tx);
        await questions.clearImage(examId, fileName, tx);
      });
      await paper.invalidate(examId);
      await recordSafely(audit, { action: 'EXAM_IMAGE_REMOVED', actorId: actor.id, entityType: 'exam', entityId: examId, ip: ctx.ip, requestId: ctx.requestId, metadata: { fileName } });
    },

    /** For the spreadsheet import: this exam's pictures by file name. */
    async byName(examId: string): Promise<Map<string, ImageRecord>> {
      return new Map((await library.listForExam(examId)).map((r) => [r.fileName, r]));
    },

    /** When an exam is deleted its pictures go too. Best effort: a store outage must not stop the deletion. */
    async purgeExam(examId: string): Promise<void> {
      try {
        for (const record of await library.takeAllForExam(examId)) {
          await images.remove(record.publicId).catch((err: unknown) => logger.error({ err, examId, fileName: record.fileName }, 'exam picture could not be removed'));
        }
      } catch (err) {
        logger.error({ err, examId }, 'exam pictures could not be cleaned up');
      }
    },
  };
}

export type QuestionImageService = ReturnType<typeof createQuestionImageService>;
