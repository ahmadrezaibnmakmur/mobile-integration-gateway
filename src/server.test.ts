import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./server.ts', import.meta.url), 'utf8');
assert.match(source, /\/api\/mobile\/v1\/session/);
assert.match(source, /AnyFlo API V2 per workflow/);
assert.doesNotMatch(source, /outlet-ops|OUTLET_OPS|Outlet Ops/);
console.log('Gateway boundary checks passed');
