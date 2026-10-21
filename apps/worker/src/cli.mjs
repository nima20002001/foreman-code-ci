import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { doctorReport, executableAvailability, hostFacts, WorkerError, requirePrivateDirectory } from './diagnostics.mjs';
import { readWorkerStatus } from './runtime.mjs';

const execute = promisify(execFile);
const args = process.argv.slice(2);
const command = args[0];
const stateDirectory = [3, 4, 5].includes(args.length) && args[1] === '--state' && isAbsolute(args[2]) ? resolve(args[2]) : null;
let runtime;
let managedSetupRetry;
let pairingErrorMessage;
const help = `Foreman Code worker

Usage:
  graphql-worker run|doctor|identity-request|initialize-native-runtime --state /absolute/private/state
  graphql-worker pair --state /absolute/private/state --enrollment-stdin
  graphql-worker pair --state /absolute/private/state --enrollment-file /absolute/private/enrollment.json
  graphql-worker capture-job-runtime --state /absolute/private/state --input /absolute/private/reviewed-capture.json
  graphql-worker refresh-job-runtime --state /absolute/private/state --input /absolute/private/reviewed-refresh.json
  graphql-worker cleanup-job-before-entry --state /absolute/private/state --grant /absolute/private/approved-grant.json

Install: node /approved/artifact/src/install-cli.mjs install --root /private/app --state /private/state --artifact /approved/artifact --manifest-sha256 APPROVED_SHA256
Update: use the same install command with the new approved artifact and hash, adding --approve-stopped-update yes.
Rollback: node /approved/artifact/src/install-cli.mjs rollback --root /private/app --state /private/state --approve-stopped-update yes
Before update or rollback, complete the approved drain/stop policy and stop the worker service. An active worker blocks replacement.
Pairing automatically prepares private managed roots and native journals and adopts a previous managed CI installation.
Arbitrary user paths still require explicit local approval. A lost established journal requires original-owner recovery.
Capture-job-runtime is a human-reviewed installer action while the worker is stopped. It refuses an existing job-runtime.json and never qualifies or launches a Job.
Refresh-job-runtime requires the previous configuration digest, completed original work and a stopped Worker. It preserves the previous configuration and requires fresh physical approval.
Cleanup-job-before-entry requires a current Main-signed human-approved grant and a stopped worker. It preserves the original journal and source bytes; it cannot stop a Job that entered native execution.
Operator MCP can read automatic setup through ci_enrollment_get and manage authorized CI enrollment and qualification. Arbitrary installer paths cannot be auto-approved through MCP.
Keep app and state in separate private persistent directories. Pairing retries reuse the original enrollment file, requestId and state identity.
`;
async function main() {
  if (!args.length || args.includes('--help') || args.includes('-h')) { process.stdout.write(help); return; }
  if (!stateDirectory || !['run', 'doctor', 'identity', 'identity-request', 'pair', 'initialize-native-runtime', 'capture-job-runtime', 'refresh-job-runtime', 'cleanup-job-before-entry'].includes(command)
    || (!['pair', 'capture-job-runtime', 'refresh-job-runtime', 'cleanup-job-before-entry'].includes(command) && args.length !== 3)
    || (command === 'pair' && !((args.length===4&&args[3]==='--enrollment-stdin')||(args.length===5&&args[3]==='--enrollment-file'&&isAbsolute(args[4]))))
    || (['capture-job-runtime', 'refresh-job-runtime'].includes(command) && !(args.length === 5 && args[3] === '--input' && isAbsolute(args[4])))
    || (command === 'cleanup-job-before-entry' && !(args.length === 5 && args[3] === '--grant' && isAbsolute(args[4])))) throw new WorkerError('usage: graphql-worker --help');
  if (command === 'run') {
    const { recoverPendingWorkerUpdate } = await import('./updateSupervisor.mjs');
    await recoverPendingWorkerUpdate(stateDirectory);
  }
  if (command === 'cleanup-job-before-entry') {
    const { cleanupJobBeforeEntry } = await import('./jobCancellationCleanup.mjs');
    console.log(JSON.stringify(await cleanupJobBeforeEntry(stateDirectory, args[4])));
    return;
  }
  if (command === 'capture-job-runtime' || command === 'refresh-job-runtime') {
    const capture = await import('./jobRuntimeCapture.mjs');
    const publish = command === 'refresh-job-runtime' ? capture.refreshJobRuntime : capture.captureJobRuntime;
    console.log(JSON.stringify(await publish(stateDirectory, args[4])));
    return;
  }
  const { loadOrCreateWorkerIdentity, loadWorkerPairing } = await import('../../../packages/contracts/src/deviceIdentityNode.ts');
  const { prepareWorkerState, startConfiguredWorker, initializeInstalledNativeRuntime } = await import('./workerFactory.mjs');
  const enrollment = command === 'pair' ? await import('./enrollment.mjs') : null;
  pairingErrorMessage = enrollment?.pairingErrorMessage;
  const facts = await hostFacts(process.env.HOME ?? '', [stateDirectory]);
  if (command === 'doctor') {
    let identity; const errors = [];
    try {
      const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
      if (!manifest || !/^\d+\.\d+\.\d+$/.test(manifest.version)
        || !Number.isSafeInteger(manifest.protocolVersion) || !Number.isSafeInteger(manifest.identityFormat)
        || !/^[a-f0-9]{40}$/.test(manifest.commit) || !/^[a-f0-9]{64}$/.test(manifest.lockfileSha256)) {
        throw new SyntaxError('Invalid Worker manifest');
      }
      Object.assign(facts, { appVersion: manifest.version, protocolVersion: manifest.protocolVersion, identityFormat: manifest.identityFormat, commit: manifest.commit, lockfileSha256: manifest.lockfileSha256 });
    } catch (error) {
      let reason = 'manifest_unreadable';
      if (error.code === 'ENOENT') reason = 'manifest_missing';
      else if (error instanceof SyntaxError) reason = 'manifest_invalid';
      errors.push(reason);
      console.warn(JSON.stringify({ operation: 'read Worker manifest', status: 'degraded', lastError: reason, failureCount: 1 }));
    }
    try {
      await requirePrivateDirectory(stateDirectory);
      // Doctor is read-only, including when the worker has never initialized identity.
      await readFile(`${stateDirectory}/identity.json`);
      identity = await loadOrCreateWorkerIdentity(stateDirectory);
      try { identity = { ...identity, ...await loadWorkerPairing(stateDirectory) }; }
      catch (error) { if (error.code !== 'ENOENT') errors.push('identity_invalid'); }
    } catch { errors.push('identity_invalid'); }
    let service = { active: false, userManagerAvailable: false };
    try {
      const { stdout } = await execute('/usr/bin/systemctl', ['--user', 'show', 'graphql-worker.service', '--property=ActiveState', '--property=LoadState'], { timeout: 2000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } });
      service = { active: stdout.includes('ActiveState=active\n'), userManagerAvailable: true };
    } catch { errors.push('systemd_user_manager_missing'); }
    let status;
    let statusUnavailable = false;
    try { status = await readWorkerStatus(stateDirectory); }
    catch (error) {
      statusUnavailable = true;
      errors.push('worker_status_unavailable');
      const lastError = typeof error.code === 'string' ? error.code : 'WORKER_STATUS_UNAVAILABLE';
      facts.inspectionErrors.push({ operation: 'read Worker runtime status', lastError, failureCount: 1 });
      console.warn(JSON.stringify({ operation: 'read Worker runtime status', status: 'degraded', lastError, failureCount: 1 }));
    }
    if (!statusUnavailable) {
      service.active = service.active && status?.active === true;
      if (!status?.active) errors.push('service_not_running');
    }
    const phase = status?.phase;
    const connection = { state: phase === 'ready' ? 'connected' : ['authenticating', 'negotiating', 'synchronizing'].includes(phase) ? 'connecting' : phase === 'disconnected' ? 'stopped' : phase, failure: status?.failure };
    if (!facts.rootPersistent) errors.push('nonpersistent_root');
    if (!facts.homePersistent) errors.push('nonpersistent_home');
    console.log(JSON.stringify(doctorReport({ facts, identity, service, connection, executables: executableAvailability(process.env.PATH ?? ''), errors })));
    return;
  }
  if (command === 'initialize-native-runtime') { await initializeInstalledNativeRuntime(stateDirectory); console.log(JSON.stringify({ nativeRuntime: 'initialized', executionAuthorized: false })); return; }
  const manifest = command === 'run' ? null : await prepareWorkerState(stateDirectory);
  if (command === 'pair') {
    await requirePrivateDirectory(stateDirectory);
    const identity = await loadOrCreateWorkerIdentity(stateDirectory);
    const result=args[3]==='--enrollment-stdin'?await enrollment.enrollWorkerCode({stateDirectory,identity,enrollmentCode:await import('./setupInput.mjs').then(module=>module.readPrivateEnrollmentCode()),appVersion:manifest.version}):await enrollment.enrollWorker({stateDirectory,identity,enrollmentFile:args[4],appVersion:manifest.version});
    console.log(JSON.stringify(result));
    return;
  }
  if(command==='identity-request'){await requirePrivateDirectory(stateDirectory);const identity=await loadOrCreateWorkerIdentity(stateDirectory);const {workerIdentityRequestCode}=await import('../../../packages/contracts/src/deviceSetupNode.ts');process.stdout.write(workerIdentityRequestCode(identity)+'\n');return;}
  if (command === 'identity') {
    await requirePrivateDirectory(stateDirectory);
    const identity = await loadOrCreateWorkerIdentity(stateDirectory);
    console.log(JSON.stringify({ formatVersion: identity.formatVersion, workerInstallationId: identity.workerInstallationId, keyRevision: identity.keyRevision, publicKey: identity.publicKey, publicKeyFingerprint: identity.publicKeyFingerprint }));
    return;
  }
  runtime = await startConfiguredWorker({ stateDirectory });
  const stop = () => {
    clearTimeout(managedSetupRetry);
    runtime.stop().then(() => process.exit(0), () => { console.error('shutdown_timeout'); process.exit(1); });
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  if (runtime.managedSetup?.state === 'failed') {
    // The user service restarts failures; keep the authenticated status available between automatic retries.
    // A running Worker update must finish first: it may deliver the release that fixes setup.
    const retry = () => {
      if (runtime.updating()) { managedSetupRetry = setTimeout(retry, 30_000); managedSetupRetry.unref(); return; }
      runtime.stop().then(() => process.exit(1), () => { console.error('shutdown_timeout'); process.exit(1); });
    };
    managedSetupRetry = setTimeout(retry, 30_000);
    managedSetupRetry.unref();
  }
}
main().catch((error) => {
  const fallback = command === 'cleanup-job-before-entry' ? 'job_cleanup_failed' : 'worker_start_failed';
  console.error(command === 'pair' && pairingErrorMessage ? pairingErrorMessage(error)
    : error instanceof WorkerError ? error.code : fallback);
  process.exitCode = 1;
});
