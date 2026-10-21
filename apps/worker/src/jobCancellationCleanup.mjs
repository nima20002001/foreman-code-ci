import { constants } from 'node:fs';
import { open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { SignedJobCancellationGrantSchema, SignedJobCancellationClosureSchema,
  JOB_CANCELLATION_GRANT_TTL_MS, jobCancellationGrantMessage,
  jobCancellationClosureMessage } from '../../../packages/contracts/src/jobCancellationRecovery.ts';
import { WorkerPairingConfigurationSchema } from '../../../packages/contracts/src/deviceIdentity.ts';
import { RemoteJobOperationReceiptRecordSchema } from '../../../packages/contracts/src/remoteJobExecution.ts';
import { publicKeyFingerprint } from '../../../packages/contracts/src/deviceIdentityNode.ts';
import { RemoteOperationJournal } from '../../../apps/api/src/modules/runs/remote/operationJournal.ts';
import { releaseMaterializationClaimForCancellation,
  preparationChildrenClosed } from '../../../apps/api/src/modules/sources/materialization.ts';
import { InstalledJobRuntimeConfigurationRecordSchema } from '../../../apps/api/src/modules/jobs/installedRuntimeHost.ts';
import { isPreparatoryVerificationOwner, JobNativeOwnerSchema } from '../../../apps/api/src/modules/jobs/executorJournal.ts';
import { readVerificationQuotaPool } from '../../../apps/api/src/modules/jobs/quotaOwnership.ts';
import { sourceMaterializationParent, sourceMaterializationComponents } from '../../../packages/contracts/src/sourceMaterialization.ts';
import { ApprovedRootAllowlistSchema } from '../../../packages/contracts/src/workspaceRootPolicies.ts';
import { sourceBindingHash, sourceMaterializationDigest } from '../../../apps/api/src/modules/sources/bindingHash.ts';
import { anchored, identity as filesystemIdentity, openPrivateRoot,
  openChildDirectory } from '../../../apps/api/src/modules/sources/privateFilesystem.ts';
import { loadApprovedRoots } from './approvedRoots.mjs';
import { acquireWorkerLock } from './runtime.mjs';
import { WorkerError } from './diagnostics.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new WorkerError(code); };

async function readPrivateBytes(parent, name, maximum = 65536, signal) {
  signal?.throwIfAborted();
  const file = await open(anchored(parent, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid() || before.mode & 0o077 || before.nlink !== 1
      || before.size < 1 || before.size > maximum) fail('job_cleanup_private_file_required');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) fail('job_cleanup_input_changed');
      offset += result.bytesRead;
    }
    const after = await file.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('job_cleanup_input_changed');
    return bytes;
  } finally { await file.close(); }
}

function checkGrant(grant, localIdentity, pairing) {
  const { execution, intent, root, materialization, registration } = grant;
  const spec = execution.acceptedSpec;
  const original = { workerInstallationId: pairing.workerInstallationId, keyRevision: pairing.keyRevision,
    authorizationRevision: pairing.authorizationRevision };
  if (localIdentity.formatVersion !== 1 || localIdentity.workerInstallationId !== pairing.workerInstallationId
    || localIdentity.keyRevision !== pairing.keyRevision
    || publicKeyFingerprint(localIdentity.publicKey) !== localIdentity.publicKeyFingerprint
    || publicKeyFingerprint(createPublicKey(createPrivateKey(localIdentity.privateKey))
      .export({ type: 'spki', format: 'pem' }).toString())
      !== localIdentity.publicKeyFingerprint) fail('job_cleanup_identity_invalid');
  if (registration.mainId !== pairing.mainId || registration.deviceId !== pairing.deviceId
    || registration.workerInstallationId !== localIdentity.workerInstallationId
    || registration.keyRevision !== localIdentity.keyRevision
    || registration.publicKeyFingerprint !== localIdentity.publicKeyFingerprint
    || registration.status === 'pending'
    || registration.authorizationRevision < pairing.authorizationRevision) fail('job_cleanup_registration_changed');
  if (spec.target.hostRef.kind !== 'device' || spec.target.hostRef.mainId !== pairing.mainId
    || spec.target.hostRef.deviceId !== pairing.deviceId || spec.target.mainId !== pairing.mainId
    || spec.target.mainInstallationId !== pairing.mainId || !isDeepStrictEqual(spec.target.registration, original)
    || !isDeepStrictEqual(root.registration, original) || !isDeepStrictEqual(root.selection.hostRef, spec.target.hostRef))
    fail('job_cleanup_pairing_changed');
  if (intent.mainId !== pairing.mainId || intent.executionId !== execution.id || intent.operationId !== execution.operationId
    || intent.attemptId !== execution.attemptId || intent.bindingHash !== spec.bindingHash
    || intent.inputDigest !== `sha256:${spec.specDigest}` || intent.subject.workspaceId !== execution.workspaceId
    || !isDeepStrictEqual(intent.owner, execution.owner)) fail('job_cleanup_intent_changed');
  if (materialization.operationId !== intent.operationId || materialization.receipt.executionId !== execution.id
    || materialization.receipt.attemptId !== execution.attemptId
    || materialization.receipt.materializationId !== spec.source.materializationId
    || materialization.receipt.verifiedManifestDigest !== spec.source.manifestDigest
    || sourceMaterializationDigest(materialization) !== spec.source.materializationDigest
    || materialization.sourceBindingHash !== sourceBindingHash(root, materialization.receipt, intent.operationId)
    || materialization.receipt.placementHash !== materialization.sourceBindingHash
    || materialization.finalDispatchBindingHash !== spec.bindingHash
    || materialization.receipt.keyRevision !== pairing.keyRevision
    || materialization.receipt.authorizationRevision !== pairing.authorizationRevision
    || !isDeepStrictEqual(materialization.receipt.binding, root.binding)
    || root.binding.workspaceId !== execution.workspaceId || root.binding.accessMode !== 'exclusive-write'
    || root.selection.rootPolicyId !== spec.target.destination.rootPolicyId
    || root.selection.rootPolicyRevision !== spec.target.destination.rootPolicyRevision
    || root.selection.locationRevision !== spec.target.destination.locationRevision
    || root.binding.snapshotId !== spec.source.snapshotId || root.source.approvedSourceId !== spec.source.approvedSourceId
    || root.source.manifestDigest !== spec.source.manifestDigest) fail('job_cleanup_source_changed');
}

function checkLifetime(grant) {
  const now = Date.now();
  if (Date.parse(grant.approvedAt) > now || Date.parse(grant.expiresAt) <= now
    || Date.parse(grant.expiresAt) - Date.parse(grant.approvedAt) > JOB_CANCELLATION_GRANT_TTL_MS)
    fail('job_cleanup_grant_expired');
}

async function checkSourceRoot(grant, approved) {
  const { root, execution } = grant;
  if (!approved || dirname(root.binding.canonicalPath) !== join(approved.managedRuntimeRoot, 'source-materializations')
    || basename(root.binding.canonicalPath) !== root.selection.rootPolicyId
    || execution.acceptedSpec.target.destination.managedRuntimeRoot !== approved.managedRuntimeRoot)
    fail('job_cleanup_root_not_approved');
  const directory = await openPrivateRoot(root.binding.canonicalPath);
  try {
    const expected = grant.filesystemRecovery?.filesystem ?? root.binding.filesystem;
    if (expected.inode !== root.binding.filesystem.inode
      || !isDeepStrictEqual(await filesystemIdentity(directory), expected))
      fail('job_cleanup_filesystem_changed');
  } finally { await directory.close(); }
}

/** Validate passive kernel/image observations; no historical filesystem UUID is inferred. */
export function validateRestoredJobFilesystem(context, configuration, observed) {
  if (observed.bootId !== context.bootId || observed.filesystem.inode !== configuration.root.binding.filesystem.inode
    || !isDeepStrictEqual(observed.filesystem, context.filesystem)) fail('job_cleanup_filesystem_changed');
  const matches = observed.mountinfo.split('\n').filter(line => line.split(' ')[0] === context.filesystem.mountId);
  if (matches.length !== 1) fail('job_cleanup_mount_changed');
  const [mount, filesystem] = matches[0].split(' - ');
  const device = mount.split(' ')[2];
  const [type, source] = filesystem?.split(' ') ?? [];
  if (!/^7:\d+$/.test(device ?? '') || type !== 'ext4' || source !== `/dev/loop${device.slice(2)}`)
    fail('job_cleanup_original_volume_required');
  if (observed.backingPath !== configuration.backingFile || observed.backingPath !== context.backingFile.path
    || observed.loopBackingPath !== observed.backingPath || observed.loopOffset !== '0' || observed.loopSizeLimit !== '0')
    fail('job_cleanup_backing_file_changed');
  const backing = observed.backingStat;
  if (!backing.regular || backing.ownerUid !== 0 || backing.mode & 0o222 || backing.links !== 1
    || backing.device !== context.backingFile.device || backing.inode !== context.backingFile.inode
    || backing.bytes !== context.backingFile.bytes || backing.bytes !== String(configuration.pins.diskBytes))
    fail('job_cleanup_backing_file_changed');
  const superblock = observed.superblock;
  if (superblock.length !== 1024 || superblock.readUInt16LE(56) !== 0xef53) fail('job_cleanup_original_volume_required');
  const hex = superblock.subarray(104, 120).toString('hex');
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (uuid !== context.filesystemUuid.toLowerCase()) fail('job_cleanup_filesystem_uuid_changed');
  return device;
}

export function validateRestoredQuotaFilesystem(context, configuration, observed) {
  const pool = configuration.descriptor.quotaPool;
  if (!pool?.filesystemUuid || observed.bootId !== context.bootId
    || observed.filesystem.inode !== configuration.root.binding.filesystem.inode
    || !isDeepStrictEqual(observed.filesystem, context.filesystem)) fail('job_cleanup_filesystem_changed');
  const matches = observed.mountinfo.split('\n').filter(line => line.split(' ')[0] === context.filesystem.mountId);
  if (matches.length !== 1 || matches[0].split(' - ')[1]?.split(' ')[0] !== 'ext4') fail('job_cleanup_mount_changed');
  if (context.kind === 'restored-original-project-quota' && context.volumeId !== configuration.machine.quota.volumeId) {
    fail('job_cleanup_original_volume_required');
  }
  if (pool.filesystemUuid !== context.filesystemUuid
    || observed.quotas.some(quota => quota.filesystemUuid !== context.filesystemUuid)) {
    fail('job_cleanup_filesystem_uuid_changed');
  }
  if (observed.quotas.length !== pool.slots.length || observed.quotas.some((quota, index) => {
    const slot = pool.slots[index];
    return quota.projectId !== slot.projectId || quota.hardLimitBytes !== slot.hardLimitBytes
      || quota.hardInodes !== slot.hardInodes || !quota.inheritance || !quota.accountingEnabled
      || quota.filesystem.inode !== slot.filesystem.inode
      || quota.filesystem.device !== context.filesystem.device || quota.filesystem.mountId !== context.filesystem.mountId;
  })) fail('job_cleanup_quota_changed');
}

function quotaProjection(configuration, filesystem, blockDevice) {
  const pool = configuration.descriptor.quotaPool;
  if (!pool) fail('job_cleanup_quota_configuration_required');
  return { ...pool, blockDevice: blockDevice ?? pool.blockDevice, slots: pool.slots.map(slot => ({ ...slot,
    filesystem: { ...slot.filesystem, device: filesystem.device, mountId: filesystem.mountId } })) };
}

async function verifyRestoredVolume(state, grant, approved, signal) {
  const configuration = InstalledJobRuntimeConfigurationRecordSchema.parse(JSON.parse(await readPrivateBytes(state, 'job-runtime.json', 2 * 1024 * 1024 + 65536, signal)));
  if (!isDeepStrictEqual(configuration.root, grant.root)
    || (configuration.schemaVersion === 2 ? configuration.descriptor.runtimeRoot : configuration.runtimeRoot)
      !== approved.managedRuntimeRoot) fail('job_cleanup_runtime_configuration_changed');
  const runtime = await openPrivateRoot(approved.managedRuntimeRoot);
  const namespace = await openPrivateRoot(grant.root.binding.canonicalPath);
  try {
    const current = await filesystemIdentity(namespace);
    const currentRuntime = await filesystemIdentity(runtime);
    if (currentRuntime.inode !== approved.runtimeFilesystem.inode || currentRuntime.device !== current.device
      || currentRuntime.mountId !== current.mountId) fail('job_cleanup_runtime_directory_changed');
    if (configuration.schemaVersion === 2 && grant.filesystemRecovery.kind === 'restored-original-project-quota') {
      const context = grant.filesystemRecovery;
      const pool = quotaProjection(configuration, context.filesystem, context.blockDevice);
      const binding = { ...grant.root.binding, filesystem: context.filesystem };
      const quotas = await readVerificationQuotaPool(pool, binding, signal);
      validateRestoredQuotaFilesystem(context, configuration, { filesystem: current, quotas,
        bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
        mountinfo: await readFile('/proc/self/mountinfo', 'utf8') });
      return;
    }
    const volumeConfiguration = configuration.schemaVersion === 2 ? { root: configuration.root,
      backingFile: configuration.descriptor.backingFile, pins: { diskBytes: configuration.descriptor.volumeCapacityBytes } }
      : configuration;
    if (grant.filesystemRecovery.kind === 'restored-original-project-quota') fail('job_cleanup_runtime_configuration_changed');
    const mountinfo = await readFile('/proc/self/mountinfo', 'utf8');
    const mount = mountinfo.split('\n').filter(line => line.split(' ')[0] === current.mountId);
    if (mount.length !== 1 || !/^7:\d+$/.test(mount[0].split(' ')[2] ?? '')) fail('job_cleanup_original_volume_required');
    const device = mount[0].split(' ')[2];
    const loop = `/sys/dev/block/${device}/loop`;
    const [loopBacking, loopOffset, loopSizeLimit, bootId] = await Promise.all([
      readFile(`${loop}/backing_file`, 'utf8'), readFile(`${loop}/offset`, 'utf8'),
      readFile(`${loop}/sizelimit`, 'utf8'), readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    ]);
    const backingPath = await realpath(volumeConfiguration.backingFile);
    if (backingPath !== volumeConfiguration.backingFile) fail('job_cleanup_backing_file_changed');
    const file = await open(backingPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat({ bigint: true });
      const superblock = Buffer.alloc(1024);
      const { bytesRead } = await file.read(superblock, 0, superblock.length, 1024);
      const after = await file.stat({ bigint: true });
      if (bytesRead !== superblock.length || before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
        fail('job_cleanup_backing_file_changed');
      validateRestoredJobFilesystem(grant.filesystemRecovery, volumeConfiguration, {
        bootId: bootId.trim(), filesystem: current, mountinfo, backingPath,
        loopBackingPath: loopBacking.trim(), loopOffset: loopOffset.trim(), loopSizeLimit: loopSizeLimit.trim(),
        backingStat: { regular: before.isFile(), ownerUid: Number(before.uid), mode: Number(before.mode),
          links: Number(before.nlink), device: before.dev.toString(), inode: before.ino.toString(), bytes: before.size.toString() },
        superblock,
      });
    } finally { await file.close(); }
  } finally { await namespace.close(); await runtime.close(); }
}

async function approvedRootsForCleanup(state, stateDirectory, grant, pairing, signal) {
  if (!grant.filesystemRecovery) return loadApprovedRoots(stateDirectory, pairing);
  const approved = ApprovedRootAllowlistSchema.parse(JSON.parse(await readPrivateBytes(state, 'approved-roots.json', 131072)));
  if (approved.hostRef.kind !== 'device' || approved.hostRef.mainId !== pairing.mainId
    || approved.hostRef.deviceId !== pairing.deviceId || approved.applicationInstallationId !== pairing.workerInstallationId)
    fail('job_cleanup_pairing_changed');
  await checkSourceRoot(grant, approved);
  await verifyRestoredVolume(state, grant, approved, signal);
  return approved;
}

function matchesReplay(receipt, grant, command, grantDigest) {
  return !receipt.entryAttempted && !receipt.native && receipt.stopFence
    && receipt.terminal?.outcome === 'cancelled' && receipt.terminal.processStopped
    && receipt.terminal.exitCode === null && receipt.terminal.signal === null
    && receipt.terminal.closureEvidenceDigest === grantDigest
    && isDeepStrictEqual(receipt.intent, grant.intent)
    && isDeepStrictEqual(receipt.execution.acceptedSpec, grant.execution.acceptedSpec)
    && receipt.controls.some(control => isDeepStrictEqual(control, command));
}

function physicalOwner(owner, execution) {
  return owner && !isPreparatoryVerificationOwner(JobNativeOwnerSchema.parse(owner), execution);
}
async function optionalPrivateBytes(state, name, maximum = 65536) {
  try { return await readPrivateBytes(state, name, maximum); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function saveClosure(state, name, closure, signal) {
  signal.throwIfAborted();
  const pending = `.job-cancellation-${randomUUID()}`;
  const file = await open(anchored(state, pending), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    | constants.O_NOFOLLOW, 0o600);
  let installed = false;
  try {
    signal.throwIfAborted();
    await file.writeFile(JSON.stringify(closure), { signal });
    await file.sync();
    signal.throwIfAborted();
    await rename(anchored(state, pending), anchored(state, name));
    installed = true;
    await state.sync();
  } finally {
    await file.close();
    if (!installed) await unlink(anchored(state, pending));
  }
}
async function completedClosure(state, name, grant, localIdentity, command, grantDigest) {
  const bytes = await optionalPrivateBytes(state, name);
  if (!bytes) return null;
  const signed = SignedJobCancellationClosureSchema.parse(JSON.parse(bytes));
  const receipt = signed.closure.receipt;
  if (signed.closure.grantId !== grant.id || !matchesReplay(receipt, grant, command, grantDigest)
    || receipt.publication !== 'complete'
    || !verify(null, Buffer.from(jobCancellationClosureMessage(signed.closure)), localIdentity.publicKey,
      Buffer.from(signed.signature, 'base64url'))) fail('job_cleanup_completed_closure_changed');
  const raw = JSON.parse(await readPrivateBytes(state, 'job-runtime-operations.json', 4 * 1024 * 1024));
  const current = raw.receipts?.find(value => value.intent?.operationId === grant.intent.operationId);
  if (!current || !isDeepStrictEqual(RemoteJobOperationReceiptRecordSchema.parse(current), receipt)
    || raw.jobOwners?.some(owner => owner.operationId === grant.intent.operationId)) {
    fail('job_cleanup_original_journal_required');
  }
  return signed;
}

/** A signed, human-approved stop for one original Job that never entered native execution. */
export async function cleanupJobBeforeEntry(stateDirectory, grantPath) {
  const state = await openPrivateRoot(stateDirectory);
  let unlock;
  let journal;
  try {
    unlock = await acquireWorkerLock(stateDirectory);
    const input = await openPrivateRoot(dirname(grantPath));
    let signed;
    try { signed = SignedJobCancellationGrantSchema.parse(JSON.parse(await readPrivateBytes(input, basename(grantPath)))); }
    finally { await input.close(); }
    const identityBytes = await readPrivateBytes(state, 'identity.json');
    const pairingBytes = await readPrivateBytes(state, 'pairing.json');
    const localIdentity = JSON.parse(identityBytes);
    const pairing = WorkerPairingConfigurationSchema.parse(JSON.parse(pairingBytes));
    if (publicKeyFingerprint(signed.mainPublicKey) !== pairing.mainPublicKeyFingerprint
      || !verify(null, Buffer.from(jobCancellationGrantMessage(signed.grant)), signed.mainPublicKey,
        Buffer.from(signed.signature, 'base64url'))) fail('job_cleanup_main_signature_invalid');
    const grant = signed.grant;
    checkGrant(grant, localIdentity, pairing);
    const command = { schemaVersion: 1, protocolVersion: 1, commandId: grant.cancelCommandId,
      operationId: grant.intent.operationId, attemptId: grant.intent.attemptId, executionId: grant.intent.executionId,
      bindingHash: grant.intent.bindingHash, subject: grant.intent.subject, owner: grant.intent.owner, action: { kind: 'stop' } };
    const grantDigest = hash(Buffer.from(jobCancellationGrantMessage(grant)));
    const closureName = `job-cancellation-closure-${grant.id}.json`;
    const cached = await completedClosure(state, closureName, grant, localIdentity, command, grantDigest);
    if (cached) return cached;
    checkLifetime(grant);
    const signal = AbortSignal.timeout(Math.max(1, Date.parse(grant.expiresAt) - Date.now()));
    const authority = async () => {
      signal.throwIfAborted();
      checkLifetime(grant);
      checkGrant(grant, localIdentity, pairing);
      if (!(await readPrivateBytes(state, 'identity.json')).equals(identityBytes)
        || !(await readPrivateBytes(state, 'pairing.json')).equals(pairingBytes)) fail('job_cleanup_identity_changed');
      await checkSourceRoot(grant, await approvedRootsForCleanup(state, stateDirectory, grant, pairing, signal));
    };
    await authority();
    const journalBytes = await readPrivateBytes(state, 'job-runtime-operations.json', 4 * 1024 * 1024);
    const originalHashMatches = hash(journalBytes) === grant.journalSha256;
    if (!originalHashMatches) {
      const raw = JSON.parse(journalBytes);
      const records = raw.receipts?.filter(receipt => receipt.intent?.operationId === grant.intent.operationId);
      const prior = records?.length === 1 ? RemoteJobOperationReceiptRecordSchema.safeParse(records[0]) : null;
      if (!prior?.success || !matchesReplay(prior.data, grant, command, grantDigest)
        || raw.jobOwners?.some(owner => owner.operationId === grant.intent.operationId && physicalOwner(owner, grant.execution)))
        fail('job_cleanup_original_journal_required');
    }
    journal = await RemoteOperationJournal.open(join(stateDirectory, 'job-runtime-operations.json'));
    const connection = await journal.jobCancellationConnection(grant.execution);
    const retained = await journal.jobStatus(grant.intent.operationId);
    if (!originalHashMatches) {
      if (retained.status !== 'known' || !matchesReplay(retained.receipt, grant, command, grantDigest)
        || physicalOwner(await journal.jobNativeOwner(grant.intent.operationId), grant.execution)) fail('job_cleanup_original_journal_required');
    }
    if (retained.status === 'known' && retained.receipt.terminal
      && retained.receipt.terminal.closureEvidenceDigest !== grantDigest) fail('job_cleanup_terminal_conflict');
    const terminal = retained.status === 'known' && retained.receipt.terminal ? retained.receipt.terminal : {
      finishedAt: new Date().toISOString(), outcome: 'cancelled', exitCode: null, signal: null, processStopped: true,
      closureEvidenceDigest: grantDigest,
      resultDigest: hash(Buffer.from(JSON.stringify({ operationId: grant.intent.operationId, outcome: 'cancelled' }))),
      logGapPossible: false, logsTruncated: false, outputCollectionError: false, artifactDigests: [],
    };
    let receipt = await journal.jobCancelBeforeEntry(grant.intent, grant.execution, connection, randomUUID(), command, terminal);
    const noEntry = async () => {
      await authority();
      const status = await journal.jobStatus(grant.intent.operationId);
      if (status.status !== 'known' || status.receipt.entryAttempted || status.receipt.native
        || !status.receipt.stopFence || status.receipt.terminal?.outcome !== 'cancelled'
        || physicalOwner(await journal.jobNativeOwner(grant.intent.operationId), grant.execution)) fail('job_cleanup_native_entry_requires_recovery');
      return await preparationChildrenClosed(sourceMaterializationParent(grant.materialization.receipt), signal) ? 'released' : 'uncertain';
    };
    let quota;
    if (grant.materialization.receipt.quota) {
      const configuration = InstalledJobRuntimeConfigurationRecordSchema.parse(JSON.parse(
        await readPrivateBytes(state, 'job-runtime.json', 2 * 1024 * 1024 + 65536, signal)));
      if (configuration.schemaVersion !== 2 || !isDeepStrictEqual(configuration.root, grant.root)) {
        fail('job_cleanup_quota_configuration_required');
      }
      const originalPool = configuration.descriptor.quotaPool;
      const owned = originalPool?.slots.find(slot => slot.namespace === grant.materialization.receipt.quota.namespace);
      if (!owned || !isDeepStrictEqual(owned, grant.materialization.receipt.quota)) fail('job_cleanup_quota_changed');
      const filesystem = grant.filesystemRecovery?.filesystem ?? grant.root.binding.filesystem;
      const blockDevice = grant.filesystemRecovery?.kind === 'restored-original-project-quota'
        ? grant.filesystemRecovery.blockDevice : originalPool.blockDevice;
      quota = { pool: quotaProjection(configuration, filesystem, blockDevice) };
    }
    const sourceFilesystem = grant.filesystemRecovery?.filesystem ?? grant.root.binding.filesystem;
    await releaseMaterializationClaimForCancellation(grant.materialization.receipt,
      sourceFilesystem, noEntry, signal, quota);
    const root = await openPrivateRoot(grant.root.binding.canonicalPath);
    let archiveBytes;
    try {
      if (grant.materialization.receipt.quota) {
        archiveBytes = await readPrivateBytes(root, `released-quota-${grant.materialization.receipt.materializationId}.json`, 16384, signal);
      } else {
        let directory = await openPrivateRoot(grant.root.binding.canonicalPath);
        try {
          for (const component of sourceMaterializationComponents(grant.materialization.receipt)) {
            const child = await openChildDirectory(directory, component);
            await directory.close();
            directory = child;
          }
          archiveBytes = await readPrivateBytes(directory, 'released-claim.json', 16384, signal);
        } finally { await directory.close(); }
      }
    } finally { await root.close(); }
    await journal.jobReleasePreparatoryOwner(grant.intent.operationId, {
      executionId: grant.execution.id, attemptId: grant.execution.attemptId, bindingHash: grant.intent.bindingHash,
      materializationId: grant.materialization.receipt.materializationId, closureEvidenceDigest: grantDigest,
    });
    await authority();
    receipt = await journal.jobPublication(grant.intent.operationId, 'complete');
    const closure = { schemaVersion: 1, grantId: grant.id, receipt, sourceClaim: {
      materializationId: grant.materialization.receipt.materializationId, reservationId: grant.materialization.reservationId,
      released: true, ...(grant.materialization.receipt.quota ? { quotaReclaimed: true } : {}), archiveSha256: hash(archiveBytes) } };
    const result = SignedJobCancellationClosureSchema.parse({ closure,
      signature: sign(null, Buffer.from(jobCancellationClosureMessage(closure)), localIdentity.privateKey).toString('base64url') });
    await saveClosure(state, closureName, result, signal);
    return result;
  } finally {
    try { await journal?.close(); }
    finally { try { await unlock?.(); } finally { await state.close(); } }
  }
}
