import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectMongo, disconnectMongo } from '../../src/config/db';
import { AuditLogModel } from '../../src/modules/audit/audit.model';
import { createAuditService } from '../../src/modules/audit/audit.service';
import { mongoUriFor } from '../helpers/mongo';

const audit = createAuditService();

beforeAll(async () => {
  await connectMongo(mongoUriFor('peacock_audit_test'));
}, 60_000);

afterAll(async () => {
  await disconnectMongo();
});

describe('audit log', () => {
  it('stores entries with secrets redacted', async () => {
    await audit.record({
      action: 'TEST_EVENT',
      after: { name: 'x', password: 'hunter2', nested: { refreshToken: 'rt-secret-xyz' } },
    });

    const stored = JSON.stringify(await AuditLogModel.find({ action: 'TEST_EVENT' }).lean());
    expect(stored).toContain('"name":"x"');
    expect(stored).not.toContain('hunter2');
    expect(stored).not.toContain('rt-secret-xyz');
  });

  it('can never be changed or deleted through the model', async () => {
    const doc = await AuditLogModel.create({ action: 'IMMUTABLE' });

    await expect(AuditLogModel.updateOne({ _id: doc._id }, { $set: { action: 'X' } })).rejects.toThrow('append-only');
    await expect(AuditLogModel.deleteMany({})).rejects.toThrow('append-only');
    doc.action = 'CHANGED';
    await expect(doc.save()).rejects.toThrow('append-only');

    expect(await AuditLogModel.countDocuments({ action: 'IMMUTABLE' })).toBe(1);
  });
});