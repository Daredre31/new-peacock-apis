import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildOpenApiDocument } from '../src/openapi';

const target = resolve('openapi/openapi.json');
const generated = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;

if (process.argv.includes('--check')) {
  const current = existsSync(target) ? readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : '';
  if (current !== generated) {
    process.stderr.write(
      'openapi/openapi.json is out of date. Run "npm run openapi:generate" and commit the result.\n',
    );
    process.exit(1);
  }
  process.stdout.write('openapi/openapi.json is up to date.\n');
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, generated);
  process.stdout.write(`Wrote ${target}\n`);
}