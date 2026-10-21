import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('companion forwards private pairing input through stdin without adding it to arguments or output', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-input-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await copyFile(new URL('../src/companion.mjs', import.meta.url), join(directory, 'companion.mjs'));
  await writeFile(join(directory, 'cli.mjs'), `let input='';for await(const chunk of process.stdin)input+=chunk;console.log(JSON.stringify({args:process.argv.slice(2),received:input==='private-test-code\\n'}));`);
  const result = spawnSync(process.execPath, [join(directory, 'companion.mjs'), '--state', '/private/state', 'pair', '--enrollment-stdin'], { input: 'private-test-code\n', encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { args: ['pair', '--state', '/private/state', '--enrollment-stdin'], received: true });
  assert.equal(result.stdout.includes('private-test-code'), false);
  assert.equal(result.stderr, '');
});
