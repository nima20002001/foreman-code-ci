import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Tests consume runner-provisioned sandbox support and never install privileged executables. */
export async function configureBrowserSandbox() {
  const scratch = join(homedir(), '.cache', 'foreman-tmp', 'chrome');
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  process.env.TMPDIR = scratch;
  const helper = process.env.CHROME_DEVEL_SANDBOX;
  if (helper) {
    const expected = process.env.CHROME_DEVEL_SANDBOX_SHA256;
    if (!/^[a-f0-9]{64}$/.test(expected ?? '')) throw new Error('A provisioned sandbox helper checksum is required.');
    const actual = createHash('sha256').update(await readFile(helper)).digest('hex');
    if (actual !== expected) throw new Error('Provisioned sandbox helper checksum mismatch.');
    const info = await lstat(helper);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || !(info.mode & 0o4000)
      || !(info.mode & 0o111) || (info.mode & 0o022)) {
      throw new Error('The provisioned sandbox helper must be root-owned, executable, setuid and not writable by other users.');
    }
    process.stdout.write('Using checksum-verified runner-provisioned Chromium sandbox.\n');
    return;
  }
  try { await execute('unshare', ['--user', '--map-root-user', 'true'], { timeout: 5000 }); }
  catch (cause) {
    try {
      const path = '/opt/google/chrome/chrome-sandbox';
      const info = await lstat(path);
      const sha256 = createHash('sha256').update(await readFile(path)).digest('hex');
      process.stdout.write(`Provisioned sandbox candidate: ${JSON.stringify({ path, sha256, uid: info.uid, mode: info.mode & 0o7777 })}\n`);
    } catch (error) {
      process.stdout.write(`Provisioned sandbox inspection failed: ${error.code ?? error.message}\n`);
    }
    throw new Error('Runner sandbox support is unavailable. Provision unprivileged user namespaces or an explicit CHROME_DEVEL_SANDBOX with CHROME_DEVEL_SANDBOX_SHA256.', { cause });
  }
  process.stdout.write('Using verified runner user-namespace sandbox support.\n');
}
