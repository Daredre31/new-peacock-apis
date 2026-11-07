import { schoolToday } from '../../common/utils/dates';
import { formatNaira } from '../../common/utils/money';
import type { structureRepository } from '../academics/structure.repository';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { NotificationService } from '../notifications/notification.service';
import type { linkRepository } from '../users/link.repository';
import type { parentRepository } from '../users/parent.repository';
import type { studentRepository } from '../users/student.repository';
import type { userRepository } from '../users/user.repository';
import type { invoiceRepository } from './invoice.repository';

interface Actor { id: string }
interface Context { ip: string; requestId: string }

const REMIND_EVERY_MS = 3 * 86_400_000;
const MAX_INVOICES_PER_RUN = 300;

export function createCollectionsService(deps: {
  invoices: Pick<typeof invoiceRepository, 'defaulters' | 'dueForReminder' | 'markReminded'>;
  structure: Pick<typeof structureRepository, 'armsByIds' | 'classesByIds'>;
  students: Pick<typeof studentRepository, 'profileMap'>;
  links: Pick<typeof linkRepository, 'activeLinksForStudents'>;
  parents: Pick<typeof parentRepository, 'nameMap'>;
  users: Pick<typeof userRepository, 'findManyByIds'>;
  notifier: Pick<NotificationService, 'notify'>;
  audit: AuditPort;
}) {
  const { invoices, structure, students, links, parents, users, notifier, audit } = deps;

  async function armLabels(ids: string[]): Promise<Map<string, string>> {
    const arms = await structure.armsByIds(ids);
    const classes = await structure.classesByIds([...arms.values()].map((a) => a.classId));
    return new Map([...arms].map(([id, a]) => [id, `${classes.get(a.classId)?.name ?? ''} ${a.name}`.trim()]));
  }

  return {
    /** Who owes money. By default only overdue invoices count; includeNotDue shows everything outstanding. */
    async defaulters(input: { page: number; limit: number; termId?: string | undefined; classArmId?: string | undefined; includeNotDue?: boolean | undefined }) {
      const report = await invoices.defaulters(
        { termId: input.termId, classArmId: input.classArmId, dueBefore: input.includeNotDue ? undefined : schoolToday() },
        { page: input.page, limit: input.limit },
      );
      const studentIds = report.rows.map((r) => r.studentId);
      const [profiles, labels, studentLinks] = await Promise.all([
        students.profileMap(studentIds), armLabels([...report.rows.map((r) => r.classArmId), ...report.byClassArm.map((a) => a.classArmId)]),
        links.activeLinksForStudents(studentIds),
      ]);
      const parentIds = [...new Set(studentLinks.map((l) => l.parentId))];
      const [names, accounts] = await Promise.all([parents.nameMap(parentIds), users.findManyByIds(parentIds)]);
      const account = new Map(accounts.map((u) => [u.id, u]));

      return {
        summary: {
          students: report.students, outstandingKobo: report.outstandingKobo,
          byClassArm: report.byClassArm.map((a) => ({ ...a, classArmName: labels.get(a.classArmId) ?? '' })).sort((a, b) => b.outstandingKobo - a.outstandingKobo),
        },
        rows: report.rows.map((r) => ({
          studentId: r.studentId, name: profiles.get(r.studentId)?.name ?? '', admissionNo: profiles.get(r.studentId)?.admissionNo ?? '',
          classArmId: r.classArmId, classArmName: labels.get(r.classArmId) ?? '', outstandingKobo: r.outstandingKobo, invoices: r.invoices, oldestDueDate: r.oldestDueDate,
          parents: studentLinks.filter((l) => l.studentId === r.studentId).map((l) => ({ parentId: l.parentId, name: names.get(l.parentId) ?? '', phone: account.get(l.parentId)?.phone ?? null })),
        })),
        total: report.students,
      };
    },

    /** Reminds parents of overdue invoices, at most one reminder per invoice every 3 days. */
    async remind(actor: Actor, input: { termId?: string | undefined; classArmId?: string | undefined; studentIds?: string[] | undefined }, ctx: Context) {
      const due = await invoices.dueForReminder(
        { termId: input.termId, classArmId: input.classArmId, studentIds: input.studentIds, overdueBefore: schoolToday() },
        new Date(Date.now() - REMIND_EVERY_MS), MAX_INVOICES_PER_RUN,
      );
      const byStudent = new Map<string, typeof due>();
      for (const inv of due) byStudent.set(inv.studentId, [...(byStudent.get(inv.studentId) ?? []), inv]);

      const studentIds = [...byStudent.keys()];
      const [profiles, studentLinks] = await Promise.all([students.profileMap(studentIds), links.activeLinksForStudents(studentIds)]);

      const perParent = new Map<string, string[]>();
      const reachable = new Set<string>();
      for (const link of studentLinks) {
        const owed = (byStudent.get(link.studentId) ?? []).reduce((sum, i) => sum + i.balanceKobo, 0);
        perParent.set(link.parentId, [...(perParent.get(link.parentId) ?? []), `${profiles.get(link.studentId)?.name ?? 'Your child'}: NGN ${formatNaira(owed)}`]);
        reachable.add(link.studentId);
      }

      for (const [parentId, lines] of perParent) {
        await notifier.notify({
          userIds: [parentId], type: 'FEE_REMINDER', title: 'Outstanding school fees',
          body: `Fees are overdue. ${lines.join('; ')}. Please pay at your earliest convenience.`, email: true,
        });
      }
      await invoices.markReminded(due.filter((i) => reachable.has(i.studentId)).map((i) => i.id), new Date());

      const result = { invoices: due.length, students: studentIds.length, parentsNotified: perParent.size, studentsWithoutParents: studentIds.length - reachable.size };
      await recordSafely(audit, { action: 'FEE_REMINDERS_SENT', actorId: actor.id, entityType: 'fees', ip: ctx.ip, requestId: ctx.requestId, metadata: result });
      return result;
    },
  };
}

export type CollectionsService = ReturnType<typeof createCollectionsService>;