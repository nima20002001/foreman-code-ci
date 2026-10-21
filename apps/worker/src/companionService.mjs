import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { userInfo } from 'node:os';
import { readInstalledRelease, readRetainedRelease, requireInstallationState, withInstallLock } from './installation.mjs';
import { hostFacts, WorkerError } from './diagnostics.mjs';
import { renderUserService } from './service.mjs';
import { workerPath } from './harnessPath.mjs';

const execute = promisify(execFile);
const hash = (value) => createHash('sha256').update(value).digest('hex');

export function createCompanionService({ home, stateDirectory, node = process.execPath, factsProvider = hostFacts, executeSystemctl = execute }) {
  const root = join(home, '.local/lib/graphql-worker');
  const state = join(home, '.local/state/graphql-worker');
  const unitPath = join(home, '.config/systemd/user/graphql-worker.service');
  const environment = { HOME: home, PATH: workerPath(home, node), XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS };
  async function plan() {
    if (stateDirectory !== state) throw new WorkerError('installation_invalid');
    await requireInstallationState({ root, stateDirectory });
    const release = await readInstalledRelease({ root, facts: await factsProvider(home, [root, state]), expected: { protocolVersion: 1, identityFormat: 1 } });
    if (!release.manifest.files.some((file) => file.path === 'artifacts/graphql-worker.service.in')) throw new WorkerError('installation_invalid');
    const unitText = renderUserService(await readFile(join(release.directory, 'artifacts/graphql-worker.service.in'), 'utf8'), {
      node, app: root, state, home, path: environment.PATH,
    });
    let retained;
    try {
      retained = await readRetainedRelease(root);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const rollbackCommands = [];
    if (retained) {
      rollbackCommands.push(['systemctl', '--user', 'stop', 'graphql-worker.service']);
      rollbackCommands.push(['APPROVED_RETAINED_NODE', join(release.directory, 'src/install-cli.mjs'),
        'rollback', '--root', root, '--state', state, '--approve-stopped-update', 'yes']);
    }
    const value = { approvedUser: userInfo().username, artifactManifestSha256: release.manifestSha256, unitPath, unitText,
      enableCommands: [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', 'graphql-worker.service']],
      rollbackCommands,
      rollbackAvailable: !!retained,
      rollbackRuntimeApprovalRequired: !!retained,
      rollbackPrerequisite: retained
        ? `Complete the approved drain/stop policy. Replace APPROVED_RETAINED_NODE with an approved executable matching the retained target ${retained.manifest.target.node}; the current Node is not selected for rollback. Identity and pairing stay in the existing private state directory.`
        : 'No previous release is retained. Rollback is unavailable.',
      lingerAction: 'none' };
    return { ...value, planSha256: hash(JSON.stringify(value)) };
  }
  async function enable(approvedPlanSha256) {
    return withInstallLock(root, async () => {
      const approved = await plan();
      if (approved.planSha256 !== approvedPlanSha256) throw new WorkerError('service_plan_changed');
      const options = { timeout: 10_000, maxBuffer: 8192, env: environment };
      // Verify the real user's manager first; never fall back to a system service.
      await executeSystemctl('/usr/bin/systemctl', ['--user', 'show', '--property=Version'], options);
      await mkdir(dirname(unitPath), { recursive: true, mode: 0o700 });
      const directory = await lstat(dirname(unitPath));
      if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o022)) throw new WorkerError('private_directory_required');
      const temporary = `${unitPath}.${randomUUID()}`;
      try { await writeFile(temporary, approved.unitText, { mode: 0o600, flag: 'wx' }); await rename(temporary, unitPath); }
      finally { await rm(temporary, { force: true }); }
      await executeSystemctl('/usr/bin/systemctl', ['--user', 'daemon-reload'], options);
      await executeSystemctl('/usr/bin/systemctl', ['--user', 'enable', '--now', 'graphql-worker.service'], options);
      return { enabled: true };
    });
  }
  return { plan, enable };
}
