import { schoolToday } from '../../common/utils/dates';
import { ROLES, type Role } from '../../config/constants';
import type { sessionRepository } from '../academics/session.repository';
import type { structureRepository } from '../academics/structure.repository';
import type { FinanceWidgets } from '../dashboards/dashboard.service';
import type { linkRepository } from '../users/link.repository';
import type { studentRepository } from '../users/student.repository';
import type { invoiceRepository } from './invoice.repository';
import type { ledgerRepository } from './ledger.repository';
import { PAYMENT_STATUS, type paymentRepository } from './payment.repository';

interface Actor { id: string; role: Role }

/** A ratio for display only. All money stays in integer kobo. */
const rate = (part: number, whole: number): number | null => (whole <= 0 ? null : Math.round((part / whole) * 1000) / 10);
const dayStart = (iso: string): Date => new Date(`${iso}T00:00:00+01:00`);

export function createFinanceAnalytics(deps: {
  invoices: Pick<typeof invoiceRepository, 'idsForScope' | 'totalsByClassArm' | 'list'>;
  ledger: Pick<typeof ledgerRepository, 'sumsByType'>;
  payments: Pick<typeof paymentRepository, 'sumByMethod' | 'collectedBetween' | 'monthlyRevenue' | 'list'>;
  sessions: Pick<typeof sessionRepository, 'findTerm' | 'findCurrentTerm' | 'findCurrentSession'>;
  structure: Pick<typeof structureRepository, 'armsByIds' | 'classesByIds'>;
  students: Pick<typeof studentRepository, 'profileMap'>;
  links: Pick<typeof linkRepository, 'activeStudentIdsOf'>;
}) {
  const { invoices, ledger, payments, sessions, structure, students, links } = deps;

  async function armLabels(ids: string[]): Promise<Map<string, string>> {
    const arms = await structure.armsByIds(ids);
    const classes = await structure.classesByIds([...arms.values()].map((a) => a.classId));
    return new Map([...arms].map(([id, a]) => [id, `${classes.get(a.classId)?.name ?? ''} ${a.name}`.trim()]));
  }

  /** Billing and settlement for one term (the current one by default), per class. */
  async function collectionForTerm(termId?: string) {
    const term = termId ? await sessions.findTerm(termId) : await sessions.findCurrentTerm();
    if (!term) return null;
    const rows = await invoices.totalsByClassArm({ termId: term.id });
    const labels = await armLabels(rows.map((r) => r.classArmId));

    const byClassArm = rows
      .map((r) => ({
        classArmId: r.classArmId, classArmName: labels.get(r.classArmId) ?? '', invoices: r.invoices, invoicedKobo: r.invoicedKobo,
        settledKobo: r.invoicedKobo - r.outstandingKobo, outstandingKobo: r.outstandingKobo, defaulters: r.defaulters,
        settledRate: rate(r.invoicedKobo - r.outstandingKobo, r.invoicedKobo),
      }))
      .sort((a, b) => a.classArmName.localeCompare(b.classArmName));

    const sum = (pick: (r: (typeof byClassArm)[number]) => number): number => byClassArm.reduce((s, r) => s + pick(r), 0);
    const invoicedKobo = sum((r) => r.invoicedKobo);
    const outstandingKobo = sum((r) => r.outstandingKobo);
    return {
      term: { id: term.id, name: term.name },
      totals: { invoices: sum((r) => r.invoices), invoicedKobo, settledKobo: invoicedKobo - outstandingKobo, outstandingKobo, defaulters: sum((r) => r.defaulters), settledRate: rate(invoicedKobo - outstandingKobo, invoicedKobo) },
      byClassArm,
    };
  }

  async function forSuperAdmin(termId?: string) {
    const collection = await collectionForTerm(termId);
    if (!collection) return { view: 'SUPER_ADMIN' as const, term: null, totals: null, byClassArm: [], cash: null, byMethod: [], collectedTodayKobo: 0, collectedThisMonthKobo: 0 };

    const today = schoolToday();
    const ids = await invoices.idsForScope({ termId: collection.term.id }, 50_000);
    const [sums, byMethod, collectedTodayKobo, collectedThisMonthKobo] = await Promise.all([
      ledger.sumsByType(ids), payments.sumByMethod(ids),
      payments.collectedBetween(dayStart(today), new Date()), payments.collectedBetween(dayStart(`${today.slice(0, 7)}-01`), new Date()),
    ]);
    const paid = -sums.PAYMENT;
    return {
      view: 'SUPER_ADMIN' as const, ...collection,
      cash: { paidKobo: paid, reversedKobo: sums.PAYMENT_REVERSAL, refundedKobo: sums.REFUND, waivedKobo: -sums.WAIVER, netCollectedKobo: paid - sums.PAYMENT_REVERSAL - sums.REFUND },
      byMethod, collectedTodayKobo, collectedThisMonthKobo,
    };
  }

  /** The admin sees rates and counts per class, never revenue totals. */
  async function forAdmin(termId?: string) {
    const collection = await collectionForTerm(termId);
    if (!collection) return { view: 'ADMIN' as const, term: null, settledRate: null, defaulters: 0, byClassArm: [] };
    return {
      view: 'ADMIN' as const, term: collection.term, settledRate: collection.totals.settledRate, defaulters: collection.totals.defaulters,
      byClassArm: collection.byClassArm.map((r) => ({ classArmId: r.classArmId, classArmName: r.classArmName, invoices: r.invoices, defaulters: r.defaulters, settledRate: r.settledRate })),
    };
  }

  async function forParent(actor: Actor) {
    const [session, childIds] = await Promise.all([sessions.findCurrentSession(), links.activeStudentIdsOf(actor.id)]);
    const [all, paid, profiles] = await Promise.all([
      invoices.list({ studentIds: childIds }, { page: 1, limit: 200, sort: '-createdAt' }),
      payments.list({ studentIds: childIds, status: PAYMENT_STATUS.SUCCESS }, { page: 1, limit: 100 }),
      students.profileMap(childIds),
    ]);
    const termNames = new Map(await Promise.all([...new Set(all.items.map((i) => i.termId))].map(async (id) => [id, (await sessions.findTerm(id))?.name ?? ''] as const)));
    const thisSession = new Set(all.items.filter((i) => i.sessionId === session?.id).map((i) => i.id));
    const net = (p: (typeof paid.items)[number]): number => p.amountKobo - p.refundedKobo;

    const children = childIds.map((studentId) => {
      const mine = all.items.filter((i) => i.studentId === studentId);
      const terms = new Map<string, { invoicedKobo: number; outstandingKobo: number }>();
      for (const i of mine) {
        const t = terms.get(i.termId) ?? { invoicedKobo: 0, outstandingKobo: 0 };
        t.invoicedKobo += i.totalKobo;
        t.outstandingKobo += Math.max(0, i.balanceKobo);
        terms.set(i.termId, t);
      }
      return {
        studentId, name: profiles.get(studentId)?.name ?? '',
        paidThisSessionKobo: paid.items.filter((p) => p.studentId === studentId && thisSession.has(p.invoiceId)).reduce((s, p) => s + net(p), 0),
        outstandingKobo: mine.reduce((s, i) => s + Math.max(0, i.balanceKobo), 0),
        byTerm: [...terms].map(([termId, t]) => ({ termId, termName: termNames.get(termId) ?? '', ...t })),
      };
    });

    return {
      view: 'PARENT' as const,
      paidThisSessionKobo: children.reduce((s, c) => s + c.paidThisSessionKobo, 0),
      outstandingKobo: children.reduce((s, c) => s + c.outstandingKobo, 0),
      children,
      timeline: [...paid.items].sort((a, b) => (b.paidAt?.getTime() ?? 0) - (a.paidAt?.getTime() ?? 0)).slice(0, 12).map((p) => ({
        paymentId: p.id, receiptNo: p.receiptNo, amountKobo: p.amountKobo, feeKobo: p.feeKobo, method: p.method,
        paidAt: p.paidAt ? p.paidAt.toISOString() : null, studentName: profiles.get(p.studentId)?.name ?? '',
      })),
    };
  }

  /** Revenue by month, split into online and offline, for the proprietor. */
  async function revenue(months: number) {
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1) - 3_600_000);
    const rows = await payments.monthlyRevenue(from, now);

    const trend = Array.from({ length: months }, (_, i) => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1 - i), 1));
      const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      const inMonth = rows.filter((r) => r.month === month);
      const online = inMonth.filter((r) => r.method === 'ONLINE').reduce((s, r) => s + r.totalKobo, 0);
      const offline = inMonth.filter((r) => r.method !== 'ONLINE').reduce((s, r) => s + r.totalKobo, 0);
      return { month, onlineKobo: online, offlineKobo: offline, totalKobo: online + offline, payments: inMonth.reduce((s, r) => s + r.count, 0) };
    });
    const methods = new Map<string, { totalKobo: number; payments: number }>();
    for (const r of rows) {
      const m = methods.get(r.method) ?? { totalKobo: 0, payments: 0 };
      m.totalKobo += r.totalKobo;
      m.payments += r.count;
      methods.set(r.method, m);
    }
    return { trend, byMethod: [...methods].map(([method, v]) => ({ method, ...v })) };
  }

  const widgets: FinanceWidgets = {
    async superAdmin() {
      const d = await forSuperAdmin();
      const [pending, review] = await Promise.all([
        payments.list({ status: PAYMENT_STATUS.PENDING, method: 'ONLINE' }, { page: 1, limit: 1 }),
        payments.list({ status: PAYMENT_STATUS.NEEDS_REVIEW }, { page: 1, limit: 1 }),
      ]);
      return { term: d.term, totals: d.totals, collectedTodayKobo: d.collectedTodayKobo, collectedThisMonthKobo: d.collectedThisMonthKobo, pendingOnlinePayments: pending.total, paymentsNeedingReview: review.total };
    },
    async admin() {
      const d = await forAdmin();
      return { term: d.term, settledRate: d.settledRate, defaulters: d.defaulters, lowestCollection: [...d.byClassArm].filter((r) => r.settledRate !== null).sort((a, b) => (a.settledRate ?? 0) - (b.settledRate ?? 0)).slice(0, 10) };
    },
    async parent(childIds: string[]) {
      if (childIds.length === 0) return { outstandingKobo: 0, children: [] };
      const all = await invoices.list({ studentIds: childIds }, { page: 1, limit: 200, sort: 'dueDate' });
      const open = all.items.filter((i) => i.balanceKobo > 0);
      return {
        outstandingKobo: open.reduce((s, i) => s + i.balanceKobo, 0),
        children: childIds.map((studentId) => {
          const mine = open.filter((i) => i.studentId === studentId);
          return { studentId, outstandingKobo: mine.reduce((s, i) => s + i.balanceKobo, 0), openInvoices: mine.length, nextDueDate: mine[0]?.dueDate ?? null };
        }),
      };
    },
  };

  return {
    collectionForTerm, revenue, widgets,
    /** Role-shaped: the proprietor sees everything, the admin only rates, a parent only their own children. */
    async forRole(actor: Actor, termId?: string) {
      if (actor.role === ROLES.SUPER_ADMIN) return forSuperAdmin(termId);
      if (actor.role === ROLES.ADMIN) return forAdmin(termId);
      return forParent(actor);
    },
  };
}

export type FinanceAnalytics = ReturnType<typeof createFinanceAnalytics>;