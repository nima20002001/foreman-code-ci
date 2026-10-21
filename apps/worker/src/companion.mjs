import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline/promises';

const [flag, state, command, ...args] = process.argv.slice(2);
const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
async function pair() {
  console.log('\nCopy this public computer request into the main app and approve pairing:');
  const request = spawnSync(process.execPath, [cli, 'identity-request', '--state', state], { stdio: 'inherit' });
  if (request.status !== 0) return request.status ?? 1;
  console.log('\nPaste the private enrollment code returned by the main app:');
  const { readPrivateEnrollmentCode } = await import('./setupInput.mjs');
  const code = await readPrivateEnrollmentCode({ input: process.stdin, output: process.stdout });
  const result = spawnSync(process.execPath, [cli, 'pair', '--state', state, '--enrollment-stdin'], { input: `${code}\n`, stdio: ['pipe', 'inherit', 'inherit'] });
  return result.status ?? 1;
}

if (flag !== '--state' || !isAbsolute(state ?? '')) {
  console.error('Open the installed Foreman Code Companion launcher.'); process.exitCode = 1;
} else if (command === '--desktop') {
  try {
    const { createCompanionServer } = await import('./companionServer.mjs');
    const server = await createCompanionServer({ stateDirectory: state });
    execFile('/usr/bin/xdg-open', [server.url], { timeout: 10_000 }, (error) => {
      if (error) { server.close(); console.error('The browser could not be opened. Run the companion launcher with onboard or doctor.'); process.exitCode = 1; }
    });
    process.once('SIGTERM', server.close); process.once('SIGINT', server.close);
  } catch { console.error('The companion window could not be opened. Check this installation with doctor.'); process.exitCode = 1; }
} else if (command === 'onboard') {
  try { process.exitCode = await pair(); }
  catch { console.error('Pairing input could not be read. Retry onboarding with the same installation.'); process.exitCode = 1; }
} else if (command) {
  const child = spawnSync(process.execPath, [cli, command, '--state', state, ...args], { stdio: 'inherit' });
  process.exitCode = child.status ?? 1;
} else {
  console.log('Foreman Code Companion\n');
  let unpaired = false;
  try {
    const report = JSON.parse(execFileSync(process.execPath, [cli, 'doctor', '--state', state], { encoding: 'utf8', timeout: 5000, maxBuffer: 32768, stdio: ['ignore', 'pipe', 'ignore'] }));
    console.log(`Version: ${report.versions.app ?? 'unknown'}\nPairing: ${report.pairing}\nConnection: ${report.connection}\nBackground service: ${report.service.active ? 'running' : 'stopped'}`);
    unpaired = report.pairing === 'unpaired';
    if (report.errors.length) console.log(`Diagnostics: ${report.errors.join(', ')}`);
  } catch { console.log('Diagnostics unavailable. Run the launcher with doctor to inspect this installation.'); }
  console.log('\nPairing must be authorized by the selected main. Installing this companion does not start its background service.');
  if (process.stdin.isTTY) {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    let connect = false;
    try { if (unpaired) connect = /^(y|yes)$/i.test((await input.question('\nPair this computer now? [y/N] ')).trim()); }
    finally { input.close(); }
    if (connect) {
      try { process.exitCode = await pair(); }
      catch { console.error('Pairing input could not be read. Retry onboarding with the same installation.'); process.exitCode = 1; }
    }
    const close = createInterface({ input: process.stdin, output: process.stdout });
    try { await close.question('\nPress Enter to close.'); } finally { close.close(); }
  }
}
