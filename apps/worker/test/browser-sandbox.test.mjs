import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configureBrowserSandbox } from './fixtures/browserSandbox.mjs';

test('requires a verified checksum for an explicitly provisioned sandbox helper without provisioning one', async t => {
  const parent = join(homedir(), '.cache', 'foreman-tmp');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'sandbox-config-'));
  const helper = join(directory, 'helper');
  await writeFile(helper, 'untrusted executable bytes', { mode: 0o600 });
  const names = ['CHROME_DEVEL_SANDBOX', 'CHROME_DEVEL_SANDBOX_SHA256', 'TMPDIR'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(async () => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await rm(directory, { recursive: true, force: true });
  });
  process.env.CHROME_DEVEL_SANDBOX = helper;
  delete process.env.CHROME_DEVEL_SANDBOX_SHA256;
  await assert.rejects(configureBrowserSandbox(), /sandbox helper checksum is required/i);
  process.env.CHROME_DEVEL_SANDBOX_SHA256 = '0'.repeat(64);
  await assert.rejects(configureBrowserSandbox(), /sandbox helper checksum mismatch/i);
});
