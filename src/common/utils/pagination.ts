import { z } from 'zod';

export const MAX_LIMIT = 100;

/** Spread into any list endpoint's query schema. */
export const paginationShape = {
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(20),
};

export const skipOf = (page: number, limit: number): number => (page - 1) * limit;