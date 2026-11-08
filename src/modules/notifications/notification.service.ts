import { AppError } from '../../common/errors/AppError';
import { logger } from '../../common/utils/logger';
import { SCHOOL_NAME, USER_STATUS } from '../../config/constants';
import type { Mailer } from '../../integrations/mailer';
import type { userRepository } from '../users/user.repository';
import { decodeCursor, type Preferences, type notificationRepository } from './notification.repository';

export interface NotifyInput {
  userIds: readonly string[];
  type: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  /** Also send an email to people who have an address and have not turned email off. */
  email?: boolean;
}

const OBJECT_ID = /^[a-f0-9]{24}$/;
const MAX_RECIPIENTS = 2000;
const EMAIL_BATCH = 10;
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const view = (n: Awaited<ReturnType<typeof notificationRepository.list>>['items'][number]) => ({ ...n, createdAt: n.createdAt.toISOString() });

export function createNotificationService(deps: {
  repo: typeof notificationRepository;
  users: Pick<typeof userRepository, 'findManyByIds'>;
  mailer: Mailer;
}) {
  const { repo, users, mailer } = deps;

  return {
    /** Never throws: a notification problem must never break the action that caused it. */
    async notify(input: NotifyInput): Promise<void> {
      try {
        const ids = [...new Set(input.userIds)].filter((id) => OBJECT_ID.test(id)).slice(0, MAX_RECIPIENTS);
        if (ids.length === 0) return;

        const prefs = await repo.preferencesFor(ids);
        const title = clip(input.title, 150);
        const body = clip(input.body, 600);

        await repo.insertMany(
          ids
            .filter((id) => prefs.get(id)?.inApp !== false)
            .map((userId) => ({ userId, type: input.type, title, body, data: input.data ?? null })),
        );

        if (input.email) {
          const targets = (await users.findManyByIds(ids)).flatMap((u) =>
            u.email && u.status === USER_STATUS.ACTIVE && prefs.get(u.id)?.email !== false ? [u.email] : [],
          );
          for (let i = 0; i < targets.length; i += EMAIL_BATCH) {
            const results = await Promise.allSettled(
              targets.slice(i, i + EMAIL_BATCH).map((to) =>
                mailer.send({ to, subject: title, text: `${body}\n\nOpen the ${SCHOOL_NAME} portal to see the details.` }),
              ),
            );
            const failed = results.filter((r) => r.status === 'rejected').length;
            if (failed > 0) logger.warn({ failed, type: input.type }, 'some notification emails failed');
          }
        }
      } catch (err) {
        logger.error({ err, type: input.type }, 'notification failed');
      }
    },

    async list(userId: string, input: { limit: number; cursor?: string | undefined; unreadOnly?: boolean | undefined }) {
      let cursor: string | null = null;
      if (input.cursor) {
        cursor = decodeCursor(input.cursor);
        if (!cursor) throw new AppError('VALIDATION_ERROR', { details: [{ field: 'cursor', issue: 'Invalid cursor' }] });
      }
      const { items, nextCursor } = await repo.list(userId, { limit: input.limit, cursor, unreadOnly: input.unreadOnly ?? false });
      return { items: items.map(view), nextCursor };
    },

    unreadCount: (userId: string) => repo.unreadCount(userId),

    async markRead(userId: string, input: { ids?: string[] | undefined; all?: true | undefined }): Promise<{ updated: number }> {
      if (!input.ids && !input.all) throw new AppError('VALIDATION_ERROR', { details: [{ field: 'body', issue: 'Send ids or all: true' }] });
      return { updated: await repo.markRead(userId, input.all ? null : (input.ids ?? []), new Date()) };
    },

    async getPreferences(userId: string): Promise<Preferences> {
      return (await repo.preferencesFor([userId])).get(userId) ?? { inApp: true, email: true };
    },

    async setPreferences(userId: string, prefs: Preferences): Promise<Preferences> {
      await repo.setPreferences(userId, prefs);
      return prefs;
    },
  };
}

export type NotificationService = ReturnType<typeof createNotificationService>;