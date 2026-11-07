import { isWeekday, isoWeekday, schoolToday } from '../../common/utils/dates';
import type { Role } from '../../config/constants';
import type { assignmentRepository } from '../academics/assignment.repository';
import type { enrolmentRepository } from '../academics/enrolment.repository';
import type { sessionRepository } from '../academics/session.repository';
import type { structureRepository } from '../academics/structure.repository';
import { ANNOUNCEMENT_STATUS, type announcementRepository } from '../announcements/announcement.repository';
import type { AnnouncementService } from '../announcements/announcement.service';
import type { attendanceRepository } from '../attendance/attendance.repository';
import type { KeyValueStore } from '../auth/keyValueStore';
import type { AttemptService } from '../cbt/attempt.service';
import { EXAM_STATUS } from '../cbt/cbt.types';
import type { examRepository } from '../cbt/exam.repository';
import type { NotificationService } from '../notifications/notification.service';
import { requestTitle } from '../requests/request.payloads';
import type { RequestRecord, requestRepository } from '../requests/request.repository';
import { REQUEST_STATUS } from '../requests/request.rules';
import { attendanceSummaryOf, termDates } from '../results/results.context';
import type { SchoolPolicy } from '../settings/settings.repository';
import type { TaskService } from '../tasks/task.service';
import type { taskRepository } from '../tasks/task.repository';
import type { TimetableService } from '../timetable/timetable.service';
import type { TeacherArmsCache } from '../academics/teacherArms';
import { LINK_STATUS, type linkRepository } from '../users/link.repository';
import type { parentRepository } from '../users/parent.repository';
import type { staffRepository } from '../users/staff.repository';
import type { studentRepository } from '../users/student.repository';

interface Actor { id: string; role: Role }

/** Phase 4 fills these in. Until then every finance widget is null. */
export interface FinanceWidgets {
  superAdmin(): Promise<Record<string, unknown> | null>;
  admin(): Promise<Record<string, unknown> | null>;
  parent(childIds: string[]): Promise<Record<string, unknown> | null>;
}
export const noFinance: FinanceWidgets = { superAdmin: async () => null, admin: async () => null, parent: async () => null };

const WEEKDAYS = ['', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] as const;
const DAY_MS = 86_400_000;
const STATS_TTL_SECONDS = 60;
const round1 = (n: number): number => Math.round(n * 10) / 10;

export interface DashboardDeps {
  students: Pick<typeof studentRepository, 'countActive' | 'profileMap'>;
  staff: Pick<typeof staffRepository, 'countActiveByType'>;
  parents: Pick<typeof parentRepository, 'countActive'>;
  structure: Pick<typeof structureRepository, 'armsByIds' | 'classesByIds' | 'subjectsByIds'>;
  sessions: Pick<typeof sessionRepository, 'findCurrentSession' | 'findCurrentTerm'>;
  attendance: Pick<typeof attendanceRepository, 'studentSummaryForDate' | 'staffSummaryForDate' | 'armIdsMarkedOn' | 'lowAttendance' | 'summaryForMany'>;
  enrolments: Pick<typeof enrolmentRepository, 'listForSession' | 'forStudents'>;
  requests: Pick<typeof requestRepository, 'list'>;
  exams: Pick<typeof examRepository, 'list' | 'upcomingForTeacher'>;
  announcementRepo: Pick<typeof announcementRepository, 'manage'>;
  links: Pick<typeof linkRepository, 'list' | 'activeStudentIdsOf'>;
  tasks: Pick<typeof taskRepository, 'listTasks' | 'countsByTask' | 'lowPerformers'>;
  assignments: Pick<typeof assignmentRepository, 'list'>;
  timetable: Pick<TimetableService, 'todayForArm' | 'todayForTeacher'>;
  taskService: Pick<TaskService, 'myTasks' | 'childTasks'>;
  attempts: Pick<AttemptService, 'myExams' | 'schedule'>;
  announcements: Pick<AnnouncementService, 'unreadCount'>;
  notifications: Pick<NotificationService, 'unreadCount'>;
  teacherArms: Pick<TeacherArmsCache, 'armIdsOf'>;
  settings: { getPolicy(): Promise<SchoolPolicy> };
  store: KeyValueStore;
  finance: FinanceWidgets;
}

export function createDashboardService(deps: DashboardDeps) {
  const { students, staff, parents, structure, sessions, attendance, enrolments, requests, exams, announcementRepo, links, tasks, assignments, timetable, taskService, attempts, announcements, notifications, teacherArms, settings, store, finance } = deps;

  async function cached<T>(key: string, ttlSeconds: number, build: () => Promise<T>): Promise<T> {
    try {
      const raw = await store.get(key);
      if (raw) return JSON.parse(raw) as T;
    } catch {
      // Redis down or entry damaged: rebuild.
    }
    const value = await build();
    try { await store.setMany([{ key, value: JSON.stringify(value), ttlSeconds }]); } catch { /* an optimisation only */ }
    return value;
  }

  async function armLabels(ids: string[]): Promise<Map<string, string>> {
    const arms = await structure.armsByIds(ids);
    const classes = await structure.classesByIds([...arms.values()].map((a) => a.classId));
    return new Map([...arms].map(([id, a]) => [id, `${classes.get(a.classId)?.name ?? ''} ${a.name}`.trim()]));
  }

  const requestItem = (r: RequestRecord) => ({
    id: r.id, reference: r.reference, type: r.type, title: requestTitle(r.type, r.payload), status: r.status, updatedAt: r.updatedAt.toISOString(),
  });

  /** The school-wide numbers shared by the super admin and admin dashboards. Cached for a minute. */
  function schoolStats() {
    return cached('dash:v1:stats', STATS_TTL_SECONDS, async () => {
      const today = schoolToday();
      const [session, term, policy] = await Promise.all([sessions.findCurrentSession(), sessions.findCurrentTerm(), settings.getPolicy()]);
      const [studentCount, staffCounts, parentCount, studentsToday, staffToday, markedIds, enrolled] = await Promise.all([
        students.countActive(), staff.countActiveByType(), parents.countActive(),
        attendance.studentSummaryForDate(today), attendance.staffSummaryForDate(today), attendance.armIdsMarkedOn(today),
        session ? enrolments.listForSession(session.id, undefined, 20_000) : Promise.resolve([]),
      ]);

      const staffTotal = staffCounts.ADMIN + staffCounts.TEACHER;
      const noted = staffToday.PRESENT + staffToday.LATE + staffToday.ON_LEAVE + staffToday.ABSENT;
      const marked = studentsToday.PRESENT + studentsToday.LATE + studentsToday.EXCUSED + studentsToday.ABSENT;

      // Classes with students, and which of them have been marked today.
      const withStudents = [...new Set(enrolled.map((e) => e.classArmId))];
      const markedSet = new Set(markedIds);
      const unmarked = isWeekday(today) ? withStudents.filter((id) => !markedSet.has(id)) : [];
      const unmarkedLabels = await armLabels(unmarked.slice(0, 20));

      const low = term && today >= termDates(term).from
        ? await attendance.lowAttendance(termDates(term).from, today, policy.lowAttendancePercent, 10)
        : [];
      const profiles = await students.profileMap(low.map((l) => l.studentId));

      return {
        date: today,
        term: term ? { id: term.id, name: term.name } : null,
        counts: { students: studentCount, teachers: staffCounts.TEACHER, admins: staffCounts.ADMIN, staff: staffTotal, parents: parentCount },
        staffToday: {
          total: staffTotal, present: staffToday.PRESENT, late: staffToday.LATE, onLeave: staffToday.ON_LEAVE, absent: staffToday.ABSENT,
          notMarked: Math.max(0, staffTotal - noted), available: Math.max(0, staffTotal - staffToday.ON_LEAVE - staffToday.ABSENT),
        },
        attendanceToday: {
          marked, present: studentsToday.PRESENT, late: studentsToday.LATE, excused: studentsToday.EXCUSED, absent: studentsToday.ABSENT,
          rate: marked === 0 ? null : round1(((marked - studentsToday.ABSENT) / marked) * 100),
          classesTotal: withStudents.length, classesMarked: withStudents.length - withStudents.filter((id) => !markedSet.has(id)).length,
        },
        unmarkedClasses: unmarked.slice(0, 20).map((id) => ({ id, name: unmarkedLabels.get(id) ?? '' })),
        lowAttendance: low.map((l) => ({ studentId: l.studentId, name: profiles.get(l.studentId)?.name ?? '', admissionNo: profiles.get(l.studentId)?.admissionNo ?? '', rate: l.rate, days: l.days, absent: l.absent })),
      };
    });
  }

  /** Attendance rate for the current term so far, for a batch of students. */
  async function termAttendance(studentIds: string[]) {
    const term = await sessions.findCurrentTerm();
    const today = schoolToday();
    if (!term || today < termDates(term).from) return new Map<string, ReturnType<typeof attendanceSummaryOf>>();
    const counts = await attendance.summaryForMany(studentIds, termDates(term).from, today);
    return new Map(studentIds.map((id) => [id, attendanceSummaryOf(counts.get(id))]));
  }

  return {
    async superAdmin(actor: Actor) {
      const [stats, escalated, fees] = await Promise.all([
        schoolStats(),
        requests.list({ statuses: [REQUEST_STATUS.ESCALATED], excludeCreatedBy: actor.id }, { page: 1, limit: 5, sort: '-updatedAt' }),
        finance.superAdmin(),
      ]);
      return { generatedAt: new Date().toISOString(), ...stats, pendingDecisions: { total: escalated.total, items: escalated.items.map(requestItem) }, fees };
    },

    /** Operational view: no revenue totals or trends, by design. */
    async admin(actor: Actor) {
      const [stats, review, pendingExams, pendingPosts, pendingLinks, fees] = await Promise.all([
        schoolStats(),
        requests.list({ statuses: [REQUEST_STATUS.SUBMITTED, REQUEST_STATUS.UNDER_REVIEW], excludeCreatedBy: actor.id }, { page: 1, limit: 5, sort: '-updatedAt' }),
        exams.list({ status: EXAM_STATUS.PENDING_APPROVAL }, { page: 1, limit: 5 }),
        announcementRepo.manage({ status: ANNOUNCEMENT_STATUS.PENDING_APPROVAL }, { page: 1, limit: 5 }),
        links.list({ status: LINK_STATUS.PENDING }, { page: 1, limit: 1 }),
        finance.admin(),
      ]);
      return {
        generatedAt: new Date().toISOString(), ...stats,
        pending: {
          requests: { total: review.total, items: review.items.map(requestItem) },
          exams: { total: pendingExams.total, items: pendingExams.items.map((e) => ({ id: e.id, title: e.title, type: e.type, windowStart: e.windowStart.toISOString() })) },
          announcements: { total: pendingPosts.total, items: pendingPosts.items.map((a) => ({ id: a.id, title: a.title, createdAt: a.createdAt.toISOString() })) },
          parentLinks: { total: pendingLinks.total },
        },
        collection: fees,
      };
    },

    async teacher(actor: Actor) {
      const now = new Date();
      const [session, term, policy] = await Promise.all([sessions.findCurrentSession(), sessions.findCurrentTerm(), settings.getPolicy()]);
      const base = { generatedAt: now.toISOString(), date: schoolToday(), weekday: WEEKDAYS[isoWeekday(schoolToday())] ?? '' };
      const unread = await notifications.unreadCount(actor.id);

      if (!session) {
        return { ...base, session: null, term: null, classes: 0, subjects: 0, pendingMarking: { total: 0, tasks: [] }, deadlines: [], exams: [], lowAttendance: [], lowScores: [], todayLessons: [], notifications: { unread } };
      }

      const [assigned, armIds, taskPage, upcoming, lessons] = await Promise.all([
        assignments.list({ teacherId: actor.id, sessionId: session.id }, { page: 1, limit: 200, sort: '-createdAt' }),
        teacherArms.armIdsOf(actor.id),
        tasks.listTasks({ teacherId: actor.id, sessionId: session.id }, { page: 1, limit: 500 }),
        exams.upcomingForTeacher(actor.id, now, 5),
        timetable.todayForTeacher(actor.id),
      ]);

      const counts = await tasks.countsByTask(taskPage.items.map((t) => t.id));
      const waiting = taskPage.items.map((t) => ({ t, awaiting: counts.get(t.id)?.awaiting ?? 0 })).filter((x) => x.awaiting > 0).sort((a, b) => b.awaiting - a.awaiting);
      const soon = taskPage.items
        .filter((t) => t.dueAt >= now && t.dueAt.getTime() <= now.getTime() + 7 * DAY_MS)
        .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime()).slice(0, 10);

      const today = schoolToday();
      const [labels, subjects, lowAttendance, lowTasks] = await Promise.all([
        armLabels([...waiting.slice(0, 5).map((x) => x.t.classArmId), ...soon.map((t) => t.classArmId)]),
        structure.subjectsByIds([...waiting.slice(0, 5).map((x) => x.t.subjectId), ...soon.map((t) => t.subjectId)]),
        term && today >= termDates(term).from ? attendance.lowAttendance(termDates(term).from, today, policy.lowAttendancePercent, 10, armIds) : Promise.resolve([]),
        tasks.lowPerformers(actor.id, session.id, policy.lowScorePercent, 10),
      ]);
      const profiles = await students.profileMap([...lowAttendance.map((l) => l.studentId), ...lowTasks.map((l) => l.studentId)]);
      const taskRow = (t: (typeof taskPage.items)[number]) => ({
        taskId: t.id, title: t.title, subjectName: subjects.get(t.subjectId)?.name ?? '', classArmName: labels.get(t.classArmId) ?? '',
        dueAt: t.dueAt.toISOString(), submitted: counts.get(t.id)?.submitted ?? 0, awaitingMarking: counts.get(t.id)?.awaiting ?? 0,
      });

      return {
        ...base, session: { id: session.id, name: session.name }, term: term ? { id: term.id, name: term.name } : null,
        classes: armIds.length, subjects: new Set(assigned.items.map((a) => a.subjectId)).size,
        pendingMarking: { total: waiting.reduce((s, x) => s + x.awaiting, 0), tasks: waiting.slice(0, 5).map((x) => taskRow(x.t)) },
        deadlines: soon.map(taskRow),
        exams: upcoming.map((e) => ({ id: e.id, title: e.title, type: e.type, windowStart: e.windowStart.toISOString(), windowEnd: e.windowEnd.toISOString() })),
        lowAttendance: lowAttendance.map((l) => ({ studentId: l.studentId, name: profiles.get(l.studentId)?.name ?? '', rate: l.rate, days: l.days })),
        lowScores: lowTasks.map((l) => ({ studentId: l.studentId, name: profiles.get(l.studentId)?.name ?? '', averagePercent: l.average, tasksGraded: l.graded })),
        todayLessons: lessons, notifications: { unread },
      };
    },

    async student(actor: Actor) {
      const session = await sessions.findCurrentSession();
      const today = schoolToday();
      const base = { generatedAt: new Date().toISOString(), date: today, weekday: WEEKDAYS[isoWeekday(today)] ?? '' };
      const [unreadPosts, unread, taskPage, examList] = await Promise.all([
        announcements.unreadCount(actor), notifications.unreadCount(actor.id),
        taskService.myTasks(actor, { page: 1, limit: 100 }), attempts.myExams(actor),
      ]);

      const armId = session ? (await enrolments.forStudents([actor.id], session.id)).get(actor.id)?.classArmId : undefined;
      const [lessons, att, labels] = await Promise.all([armId ? timetable.todayForArm(armId) : Promise.resolve([]), termAttendance([actor.id]), armId ? armLabels([armId]) : Promise.resolve(new Map<string, string>())]);

      const open = taskPage.items.filter((t) => t.status === 'PENDING' || t.status === 'RETURNED').sort((a, b) => a.dueAt.localeCompare(b.dueAt));
      return {
        ...base, classArm: armId ? { id: armId, name: labels.get(armId) ?? '' } : null,
        todayLessons: lessons,
        tasks: {
          pending: open.length, overdue: taskPage.items.filter((t) => t.status === 'OVERDUE').length,
          next: open.slice(0, 5).map((t) => ({ taskId: t.id, title: t.title, subjectName: t.subjectName, dueAt: t.dueAt, status: t.status })),
        },
        exams: examList.filter((e) => ['OPEN', 'UPCOMING', 'IN_PROGRESS'].includes(e.state)).sort((a, b) => a.windowStart.localeCompare(b.windowStart)).slice(0, 5)
          .map((e) => ({ id: e.id, title: e.title, subjectName: e.subjectName, windowStart: e.windowStart, windowEnd: e.windowEnd, state: e.state })),
        attendance: att.get(actor.id) ?? null,
        announcements: { unread: unreadPosts.unread }, notifications: { unread },
      };
    },

    /** The family view with one block per child. Each child's data goes through the same scope checks as everywhere else. */
    async parent(actor: Actor) {
      const session = await sessions.findCurrentSession();
      const childIds = await links.activeStudentIdsOf(actor.id);
      const [unreadPosts, unread, schedule, profiles, att, fees] = await Promise.all([
        announcements.unreadCount(actor), notifications.unreadCount(actor.id), attempts.schedule(actor),
        students.profileMap(childIds), termAttendance(childIds), finance.parent(childIds),
      ]);
      const enrolled = session ? await enrolments.forStudents(childIds, session.id) : new Map();
      const labels = await armLabels([...enrolled.values()].map((e: { classArmId: string }) => e.classArmId));
      const now = Date.now();

      const children = await Promise.all(childIds.map(async (id) => {
        const taskPage = await taskService.childTasks(actor, id, { page: 1, limit: 100 });
        const open = taskPage.items.filter((t) => t.status === 'PENDING' || t.status === 'RETURNED').sort((a, b) => a.dueAt.localeCompare(b.dueAt));
        const nextExam = schedule.filter((x) => x.studentId === id && Date.parse(x.windowEnd) >= now).sort((a, b) => a.windowStart.localeCompare(b.windowStart))[0];
        const armId = (enrolled.get(id) as { classArmId: string } | undefined)?.classArmId;
        return {
          id, name: profiles.get(id)?.name ?? '', admissionNo: profiles.get(id)?.admissionNo ?? '',
          classArmName: armId ? (labels.get(armId) ?? null) : null, attendance: att.get(id) ?? null,
          tasks: {
            pending: open.length, overdue: taskPage.items.filter((t) => t.status === 'OVERDUE').length,
            next: open.slice(0, 3).map((t) => ({ taskId: t.id, title: t.title, subjectName: t.subjectName, dueAt: t.dueAt })),
          },
          nextExam: nextExam ? { examId: nextExam.examId, title: nextExam.title, subjectName: nextExam.subjectName, windowStart: nextExam.windowStart, windowEnd: nextExam.windowEnd } : null,
        };
      }));

      return {
        generatedAt: new Date().toISOString(), children: children.sort((a, b) => a.name.localeCompare(b.name)),
        announcements: { unread: unreadPosts.unread }, notifications: { unread }, fees,
      };
    },
  };
}

export type DashboardService = ReturnType<typeof createDashboardService>;
