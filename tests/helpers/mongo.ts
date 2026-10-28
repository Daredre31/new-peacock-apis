import { inject } from 'vitest';

/** The shared test server, with a database name of your choice so test files never share data. */
export function mongoUriFor(dbName: string): string {
  const url = new URL(inject('mongoUri'));
  url.pathname = `/${dbName}`;
  return url.toString();
}