import { AppError } from '../../common/errors/AppError';
import { schoolToday } from '../../common/utils/dates';
import { formatNaira } from '../../common/utils/money';
import type { sessionRepository } from '../academics/session.repository';
import type { structureRepository } from '../academics/structure.repository';
import type { ReportInput } from '../reports/report.generators';
import type { TableData } from '../reports/report.formats';
import type { ReportParams } from '../reports/report.repository';
import type { FinanceAnalytics } from './analytics.service';
import type { CollectionsService } from './collections.service';

export interface FinanceReports {
  prepareSummary(input: ReportInput): Promise<ReportParams>;
  runSummary(params: ReportParams): Promise<TableData>;
  prepareDefaulters(input: ReportInput): Promise<ReportParams>;
  runDefaulters(params: ReportParams): Promise<TableData>;
}

const fail = (field: string, issue: string): AppError => new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });
const money = (kobo: number): string => formatNaira(kobo);

export function createFinanceReports(deps: {
  analytics: Pick<FinanceAnalytics, 'collectionForTerm'>;
  collections: Pick<CollectionsService, 'defaulters'>;
  sessions: Pick<typeof sessionRepository, 'findTerm' | 'findCurrentTerm'>;
  structure: Pick<typeof structureRepository, 'findArm'>;
}): FinanceReports {
  const { analytics, collections, sessions, structure } = deps;

  async function termOf(termId: string | undefined) {
    const term = termId ? await sessions.findTerm(termId) : await sessions.findCurrentTerm();
    if (!term) throw fail('termId', termId ? 'Term not found' : 'There is no current term');
    return term;
  }

  return {
    async prepareSummary(input) {
      return { termId: (await termOf(input.termId)).id };
    },
    async runSummary(params) {
      const data = await analytics.collectionForTerm(params.termId);
      if (!data) throw fail('termId', 'Term not found');
      const rows: (string | number | null)[][] = data.byClassArm.map((r) => [r.classArmName, r.invoices, money(r.invoicedKobo), money(r.settledKobo), money(r.outstandingKobo), r.defaulters, r.settledRate]);
      rows.push(['TOTAL', data.totals.invoices, money(data.totals.invoicedKobo), money(data.totals.settledKobo), money(data.totals.outstandingKobo), data.totals.defaulters, data.totals.settledRate]);
      return {
        title: 'Financial summary', subtitle: `${data.term.name}. Amounts in NGN. "Settled" means paid or waived. Generated ${schoolToday()}`,
        columns: ['Class', 'Invoices', 'Invoiced', 'Settled', 'Outstanding', 'Owing', 'Settled %'], rows,
      };
    },

    async prepareDefaulters(input) {
      const term = await termOf(input.termId);
      if (input.classArmId && !(await structure.findArm(input.classArmId))) throw fail('classArmId', 'Class arm not found');
      return { termId: term.id, ...(input.classArmId ? { classArmId: input.classArmId } : {}) };
    },
    async runDefaulters(params) {
      const data = await collections.defaulters({ page: 1, limit: 2000, termId: params.termId, classArmId: params.classArmId });
      return {
        title: 'Fee defaulters', subtitle: `Overdue invoices only. Amounts in NGN. Generated ${schoolToday()}`,
        columns: ['Admission No', 'Name', 'Class', 'Outstanding', 'Invoices', 'Oldest due date', 'Parent phones'],
        rows: data.rows.map((r) => [r.admissionNo, r.name, r.classArmName, money(r.outstandingKobo), r.invoices, r.oldestDueDate, r.parents.map((p) => p.phone).filter(Boolean).join(' / ')]),
      };
    },
  };
}