import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ApprovedRootAllowlistSchema } from '../../../packages/contracts/src/workspaceRootPolicies.ts';
import { verifyApprovedRootAllowlist } from '../../../apps/api/src/modules/sources/rootAttestation.ts';
import { hostFacts, requirePrivateDirectory, WorkerError } from './diagnostics.mjs';

// Pairing installs managed roots. Arbitrary bases still require local human approval.
export async function loadApprovedRoots(stateDirectory, pairing) {
  await requirePrivateDirectory(stateDirectory);
  const file = join(stateDirectory, 'approved-roots.json');
  let info;
  try { info = await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 128 * 1024) throw new WorkerError('approved_roots_private_file_required');
  let allowlist;
  try { allowlist = ApprovedRootAllowlistSchema.parse(JSON.parse(await readFile(file, 'utf8'))); }
  catch { throw new WorkerError('approved_roots_configuration_invalid'); }
  if (allowlist.hostRef.kind !== 'device' || allowlist.hostRef.mainId !== pairing.mainId || allowlist.hostRef.deviceId !== pairing.deviceId || allowlist.applicationInstallationId !== pairing.workerInstallationId) throw new WorkerError('approved_roots_identity_mismatch');
  const paths = [...allowlist.bases.map((base) => base.canonicalPath), allowlist.managedRuntimeRoot];
  for (const path of paths) {
    const directory = await lstat(path).catch(() => { /* ignore: an unreadable root is reported just below as approved_root_directory_unavailable */ return null; });
    if (!directory?.isDirectory()) throw new WorkerError('approved_root_directory_unavailable');
  }
  const facts = await hostFacts(process.env.HOME ?? '', paths);
  if (!facts.rootPersistent || !facts.homePersistent || !facts.storagePersistent) throw new WorkerError('approved_root_not_persistent');
  try { return await verifyApprovedRootAllowlist(allowlist); }
  catch { throw new WorkerError('approved_root_filesystem_mismatch'); }
}
