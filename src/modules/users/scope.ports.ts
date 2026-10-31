import type { ScopePorts } from '../../common/scope/ports';
import type { enrolmentRepository } from '../academics/enrolment.repository';
import type { sessionRepository } from '../academics/session.repository';
import type { TeacherArmsCache } from '../academics/teacherArms';
import type { linkRepository } from './link.repository';
import type { studentRepository } from './student.repository';

export function createScopePorts(deps: {
  links: Pick<typeof linkRepository, 'hasActive'>;
  students: Pick<typeof studentRepository, 'findByUserId'>;
  enrolments: Pick<typeof enrolmentRepository, 'forStudents'>;
  sessions: Pick<typeof sessionRepository, 'findCurrentSession'>;
  teacherArms: Pick<TeacherArmsCache, 'armIdsOf' | 'classTeacherArmIdsOf'>;
}): ScopePorts {
  return {
    parentHasActiveLink: (parentUserId, studentId) => deps.links.hasActive(parentUserId, studentId),

    teacherTeachesStudent: async (teacherUserId, studentId) => {
      const current = await deps.sessions.findCurrentSession();
      if (!current) return false;
      const arms = await deps.teacherArms.armIdsOf(teacherUserId);
      if (arms.length === 0) return false;
      const enrolled = await deps.enrolments.forStudents([studentId], current.id);
      const armId = enrolled.get(studentId)?.classArmId;
      return armId !== undefined && arms.includes(armId);
    },

    teacherTeachesClassArm: async (teacherUserId, classArmId) =>
      (await deps.teacherArms.armIdsOf(teacherUserId)).includes(classArmId),

    isClassTeacher: async (teacherUserId, classArmId) =>
      (await deps.teacherArms.classTeacherArmIdsOf(teacherUserId)).includes(classArmId),

    // A student's id and their user id are the same thing in this API.
    studentIdOfUser: async (userId) => ((await deps.students.findByUserId(userId)) ? userId : null),
  };
}