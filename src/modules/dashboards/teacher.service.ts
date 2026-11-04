import { AppError } from '../../common/errors/AppError';
import { schoolToday } from '../../common/utils/dates';
import type { Role } from '../../config/constants';
import type { assignmentRepository } from '../academics/assignment.repository';
import type { enrolmentRepository } from '../academics/enrolment.repository';
import type { sessionRepository } from '../academics/session.repository';
import type { structureRepository } from '../academics/structure.repository';
import type { TeacherArmsCache } from '../academics/teacherArms';
import type { attendanceRepository } from '../attendance/attendance.repository';
import { attendanceSummaryOf, termDates } from '../results/results.context';
import type { linkRepository } from '../users/link.repository';
import type { parentRepository } from '../users/parent.repository';
import type { studentRepository } from '../users/student.repository';
import type { userRepository } from '../users/user.repository';

interface Actor { id: string; role: Role }

export function createTeacherPortalService(deps: {
  sessions: Pick<typeof sessionRepository, 'findCurrentSession' | 'findCurrentTerm'>;
  assignments: Pick<typeof assignmentRepository, 'list'>;
  teacherArms: Pick<TeacherArmsCache, 'classTeacherArmIdsOf'>;
  structure: Pick<typeof structureRepository, 'findArm' | 'armsByIds' | 'classesByIds' | 'subjectsByIds'>;
  enrolments: Pick<typeof enrolmentRepository, 'studentIdsInArms'>;
  students: Pick<typeof studentRepository, 'profileMap'>;
  attendance: Pick<typeof attendanceRepository, 'summaryForMany'>;
  links: Pick<typeof linkRepository, 'activeLinksForStudents'>;
  parents: Pick<typeof parentRepository, 'nameMap'>;
  users: Pick<typeof userRepository, 'findManyByIds'>;
}) {
  const { sessions, assignments, teacherArms, structure, enrolments, students, attendance, links, parents, users } = deps;

  async function armLabels(ids: string[]): Promise<Map<string, string>> {
    const arms = await structure.armsByIds(ids);
    const classes = await structure.classesByIds([...arms.values()].map((a) => a.classId));
    return new Map([...arms].map(([id, a]) => [id, `${classes.get(a.classId)?.name ?? ''} ${a.name}`.trim()]));
  }

  return {
    /** Every class the teacher teaches or is class teacher of this session, with subjects and student counts. */
    async classes(actor: Actor) {
      const session = await sessions.findCurrentSession();
      if (!session) return [];

      const [{ items }, classTeacherOf] = await Promise.all([
        assignments.list({ teacherId: actor.id, sessionId: session.id }, { page: 1, limit: 200, sort: '-createdAt' }),
        teacherArms.classTeacherArmIdsOf(actor.id),
      ]);
      const armIds = [...new Set([...items.map((a) => a.classArmId), ...classTeacherOf])];
      const [labels, subjects] = await Promise.all([armLabels(armIds), structure.subjectsByIds(items.map((a) => a.subjectId))]);
      const counts = new Map(await Promise.all(armIds.map(async (id) => [id, (await enrolments.studentIdsInArms([id], session.id)).length] as const)));

      return armIds
        .map((id) => ({
          classArmId: id, classArmName: labels.get(id) ?? '', isClassTeacher: classTeacherOf.includes(id), studentCount: counts.get(id) ?? 0,
          subjects: items.filter((a) => a.classArmId === id).flatMap((a) => { const s = subjects.get(a.subjectId); return s ? [{ id: s.id, name: s.name, code: s.code }] : []; }),
        }))
        .sort((a, b) => a.classArmName.localeCompare(b.classArmName));
    },

    /** The class teacher's roster: each student's attendance rate this term and their parents' contact details. */
    async roster(actor: Actor, armId: string) {
      const arm = await structure.findArm(armId);
      if (!arm || arm.classTeacherId !== actor.id) throw new AppError('NOT_FOUND'); // only the class teacher
      const [session, term] = await Promise.all([sessions.findCurrentSession(), sessions.findCurrentTerm()]);
      if (!session) return { classArm: { id: armId, name: '' }, students: [] };

      const studentIds = await enrolments.studentIdsInArms([armId], session.id);
      const today = schoolToday();
      const [profiles, labels, counts, activeLinks] = await Promise.all([
        students.profileMap(studentIds), armLabels([armId]),
        term && today >= termDates(term).from ? attendance.summaryForMany(studentIds, termDates(term).from, today) : Promise.resolve(new Map()),
        links.activeLinksForStudents(studentIds),
      ]);
      const parentIds = [...new Set(activeLinks.map((l) => l.parentId))];
      const [accounts, names] = await Promise.all([users.findManyByIds(parentIds), parents.nameMap(parentIds)]);
      const account = new Map(accounts.map((u) => [u.id, u]));

      return {
        classArm: { id: armId, name: labels.get(armId) ?? '' },
        students: studentIds
          .map((id) => ({
            studentId: id, name: profiles.get(id)?.name ?? '', admissionNo: profiles.get(id)?.admissionNo ?? '',
            attendance: attendanceSummaryOf(counts.get(id)),
            parents: activeLinks.filter((l) => l.studentId === id).map((l) => ({
              parentId: l.parentId, name: names.get(l.parentId) ?? '', relationship: l.relationship,
              phone: account.get(l.parentId)?.phone ?? null, email: account.get(l.parentId)?.email ?? null,
            })),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    },
  };
}

export type TeacherPortalService = ReturnType<typeof createTeacherPortalService>;