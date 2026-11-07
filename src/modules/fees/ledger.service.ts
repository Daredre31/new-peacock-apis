import type { ClientSession } from 'mongoose';
import { AppError } from '../../common/errors/AppError';
import type { BalanceGuard, InvoiceRecord, invoiceRepository } from './invoice.repository';
import type { EntryInput, LedgerRecord, ledgerRepository } from './ledger.repository';

export function createLedgerService(deps: {
  ledger: Pick<typeof ledgerRepository, 'insert'>;
  invoices: Pick<typeof invoiceRepository, 'adjustBalance'>;
}) {
  return {
    /**
     * Writes one ledger entry and moves the invoice balance by the same amount.
     * Must be called inside a transaction, so the entry and the balance succeed or fail together.
     * A duplicate payment or request throws a duplicate-key error from the unique indexes.
     */
    async post(entry: EntryInput, guard: BalanceGuard, session: ClientSession): Promise<{ entry: LedgerRecord; invoice: InvoiceRecord }> {
      if (!Number.isSafeInteger(entry.amountKobo) || entry.amountKobo === 0) {
        throw new AppError('PAYMENT_AMOUNT_INVALID', { message: 'The amount must be a whole number of kobo' });
      }
      const recorded = await deps.ledger.insert(entry, session);
      const result = await deps.invoices.adjustBalance(entry.invoiceId, entry.amountKobo, guard, session);
      if (!result.ok) {
        if (result.reason === 'MISSING') throw new AppError('NOT_FOUND');
        throw new AppError('CONFLICT', { message: 'The invoice balance changed. Reload it and try again.' });
      }
      return { entry: recorded, invoice: result.invoice };
    },
  };
}

export type LedgerService = ReturnType<typeof createLedgerService>;