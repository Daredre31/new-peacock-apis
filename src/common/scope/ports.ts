export interface ScopePorts {
  /** Is there an ACTIVE parent-student link between this parent login and this student? */
  parentHasActiveLink(parentUserId: string, studentId: string): Promise<boolean>;
  /** Does this teacher hold a teaching assignment, or the class teacher role, covering this student this session? */
  teacherTeachesStudent(teacherUserId: string, studentId: string): Promise<boolean>;
  teacherTeachesClassArm(teacherUserId: string, classArmId: string): Promise<boolean>;
  isClassTeacher(teacherUserId: string, classArmId: string): Promise<boolean>;
  /** The student record that belongs to this login, if there is one. */
  studentIdOfUser(userId: string): Promise<string | null>;
}

/** Until Phase 2 provides the real thing, nobody is in anyone's scope. Failing closed is the safe default. */
export const denyAllScopePorts: ScopePorts = {
  parentHasActiveLink: async () => false,
  teacherTeachesStudent: async () => false,
  teacherTeachesClassArm: async () => false,
  isClassTeacher: async () => false,
  studentIdOfUser: async () => null,
};