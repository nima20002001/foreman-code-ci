import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const digest = 'a'.repeat(64);
const image = `sha256:${digest}`;

/** Filesystem and installation inputs only; this fixture never qualifies a runtime. */
export async function managedRuntimeFixture({ home, state, pairing, worker }) {
  home = await realpath(home);
  const base = join(home, '.local/share/foreman-code/ci-verification');
  const runtimeRoot = join(base, 'volume/managed');
  const policyId = randomUUID();
  const source = join(runtimeRoot, 'source-materializations', policyId);
  const qualificationSource = join(runtimeRoot, 'installer/source');
  for (const path of [runtimeRoot, source, qualificationSource, join(base, 'workspaces')]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  const hostRef = { kind: 'device', mainId: pairing.mainId, deviceId: pairing.deviceId };
  const registration = { workerInstallationId: pairing.workerInstallationId, keyRevision: pairing.keyRevision,
    authorizationRevision: pairing.authorizationRevision };
  const approved = await worker.qualifyApprovedRootAllowlist({ schemaVersion: 1, hostRef,
    applicationInstallationId: pairing.workerInstallationId, configurationRevision: '1',
    bases: [{ baseId: randomUUID(), canonicalPath: join(base, 'workspaces'), accessModes: ['read-write'] }],
    managedRuntimeRoot: runtimeRoot });
  const filesystemFor = async path => {
    const info = await stat(path, { bigint: true });
    return { device: String(info.dev), inode: String(info.ino), mountId: approved.runtimeFilesystem.mountId };
  };
  const pin = { approvedSourceId: randomUUID(), snapshotId: randomUUID(), manifestDigest: digest };
  const root = { version: 1, source: pin, selection: { hostRef, rootPolicyId: policyId,
    rootPolicyRevision: '1', locationRevision: '1' }, registration,
    binding: { version: 1, mainId: pairing.mainId, deviceId: pairing.deviceId,
      workerInstallationId: pairing.workerInstallationId, workspaceId: 'fixture-workspace', rootId: randomUUID(),
      bindingRevision: 1, locationRevision: 1, canonicalPath: source, filesystem: await filesystemFor(source),
      accessMode: 'exclusive-write', snapshotId: pin.snapshotId, manifestDigest: pin.manifestDigest },
    ownerPrincipalId: 'owner', authorizedByPrincipalId: 'owner', attestationId: randomUUID(),
    attestationDigest: digest, boundAt: '2026-10-01T00:00:00.000Z' };
  const executable = await realpath('/usr/bin/true');
  const binarySha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
  const seedReceiptPath = join(base, 'seed.json');
  await writeFile(seedReceiptPath, '{}', { mode: 0o600 });
  const seedReceiptSha256 = createHash('sha256').update('{}').digest('hex');
  const limits = { cpuLimit: 2, memoryBytes: 2 * 2 ** 30, pidsLimit: 512, diskBytes: 8 * 2 ** 30 };
  const resources = { schemaVersion: 1, limits, mutableInodes: 100000, controlTempBytes: 64 * 2 ** 20,
    scratchBytes: 2 ** 30, scratchExecutable: true, shmBytes: 64 * 2 ** 20,
    spoolBytes: 32 * 2 ** 20, reportBytes: 64 * 2 ** 20 };
  const slots = [];
  for (const projectId of [74001, 74002]) {
    const namespace = randomUUID();
    await mkdir(join(source, namespace), { mode: 0o700 });
    slots.push({ namespace, projectId, hardLimitBytes: limits.diskBytes, hardInodes: resources.mutableInodes,
      filesystem: await filesystemFor(join(source, namespace)) });
  }
  const quotaPool = { queryExecutable: executable, queryBinarySha256: binarySha256, blockDevice: '/dev/loop0',
    volumeCapacityInodes: 1000000, filesystemUuid: randomUUID(), slots };
  const quota = { volumeId: quotaPool.filesystemUuid, mountIdentityDigest: digest,
    volumeCapacityBytes: 64 * 2 ** 30, growthMode: 'filesystem-project-quota', reservedHostBytes: 2 ** 30,
    controlProjectId: 74000, workloadProjectId: 74001, controlHardLimitBytes: 2 * 2 ** 30, controlUsageBytes: 0,
    workloadHardLimitBytes: limits.diskBytes, workloadUsageBytes: 0, controlHardInodes: 10000, controlUsedInodes: 0,
    workloadHardInodes: resources.mutableInodes, workloadUsedInodes: 0, quotaRevision: 1, quotaDigest: digest,
    accountingEnabled: true, enforcementEnabled: true, inheritanceVerified: true, rootlessAccountingVerified: true };
  const target = { hostRef, registration, mainInstallationId: pairing.mainId };
  const network = { schemaVersion: 2, mode: 'none' };
  const approvalConfig = { schemaVersion: 1, revision: 1, approvalLifetimeMs: 86400000,
    review: { authority: 'repository-owner', decisionId: 'fixture', reviewedOn: '2026-10-01', decisionDigest: digest } };
  const runtimeFacts = { resourcePolicyRevision: 1, resourcePolicyDigest: digest, runtimeApprovalId: randomUUID(),
    runtimeApprovalRevision: 1, aggregateCgroupIdentityDigest: digest };
  const runtime = { schemaVersion: 2, root, descriptor: { target, runtimeExecutable: executable,
    ociExecutable: executable, findmntExecutable: executable, findmntBinarySha256: binarySha256,
    runtimeRoot, backingFile: null, controllerEnvironment: { PATH: '/usr/bin:/bin',
      XDG_RUNTIME_DIR: home, LANG: 'C.UTF-8' }, volumeCapacityBytes: quota.volumeCapacityBytes,
    quota, quotaPool, resources, network, approvalConfig, ...runtimeFacts },
    machine: { ...runtimeFacts, provisioningSuite: 'rootless-podman-ext4-project-quota-private-git-v3',
      deviceLimits: { cpuLimit: 4.25, memoryBytes: 8 * 2 ** 30, diskBytes: quota.volumeCapacityBytes, pidsLimit: 1088 },
      quota, quotaPool, bootId: randomUUID(), runtimeExecutable: executable, runtimeBinarySha256: binarySha256,
      ociExecutable: executable, ociBinarySha256: binarySha256, configurationDigest: digest,
      imageDigest: image, toolchainDigest: digest, limits, workspaceLayout: 'source-inputs-private-git-scheduler-v1',
      network, resources, approvalConfig, imageManifestDigest: image, imageConfigDigest: image,
      tools: [], seedReceiptSha256, sourceCommit: 'b'.repeat(40) },
    seedReceiptPath, seedReceiptSha256,
    qualificationSource: { directory: qualificationSource, manifest: { version: 1, ...pin,
      git: { commit: 'b'.repeat(40), tree: 'c'.repeat(40), objectFormat: 'sha1' },
      capturePolicy: 'git-tree-v1', executablePolicy: 'preserve-approved', entries: [], deletions: [],
      totalEntries: 0, totalBytes: 0 } } };
  await writeFile(join(state, 'approved-roots.json'), JSON.stringify(approved), { mode: 0o600 });
  await writeFile(join(state, 'job-runtime.json'), JSON.stringify(runtime), { mode: 0o600 });
  const readQuota = async (_pool, directory) => {
    const slot = slots.find(value => directory.endsWith(`/${value.namespace}`));
    return { filesystemUuid: quotaPool.filesystemUuid, volumeCapacityBytes: quota.volumeCapacityBytes,
      volumeCapacityInodes: quotaPool.volumeCapacityInodes, projectId: slot.projectId,
      inheritance: true, hardLimitBytes: slot.hardLimitBytes, hardInodes: slot.hardInodes,
      usedBytes: 0, usedInodes: 0, accountingEnabled: true, filesystem: await filesystemFor(directory) };
  };
  return { runtime, approved, readQuota };
}
