import { it, expect } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, open, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TransferIntent } from '@foreman-code/contracts/byte-transfer'
import { NodeRsyncExecutor, RsyncStagingTransport, RSYNC_SSH_ARGS, type RsyncEndpoint,
  type RsyncStagingPorts, type RsyncExecutor } from './rsync.js'
import { RsyncPrivateStore } from './rsyncStore.js'

it('actual PC/Builder private staging push, pull, empty, source freeze and interrupted resume', async () => {
  const binary = process.env.RSYNC_PHYSICAL_LOCAL_BINARY!, binaryHash = process.env.RSYNC_PHYSICAL_LOCAL_SHA256!
  const remoteBinary = process.env.RSYNC_PHYSICAL_REMOTE_BINARY!, remoteHash = process.env.RSYNC_PHYSICAL_REMOTE_SHA256!
  expect(binary).toBeTruthy(); expect(binaryHash).toMatch(/^[a-f0-9]{64}$/)
  const root = await mkdtemp('/tmp/graphql-rsync-physical-'), run = randomUUID()
  const remoteRoot = `/home/builder/.local/share/graphql-rsync-test/${run}`
  const config: RsyncEndpoint = { user: 'builder', host: '100.64.0.20', localBinary: binary,
    remoteBinary, localRoot: join(root, 'private'), remoteRoot, localBinarySha256: binaryHash, remoteBinarySha256: remoteHash }
  const executor = new NodeRsyncExecutor(), signal = new AbortController().signal
  const ssh = (command: string) => executor.run({ executable: '/usr/bin/ssh', args: [...RSYNC_SSH_ARGS,
    'builder@100.64.0.20', command] }, signal)
  const context = (i: TransferIntent) => ({ mainId: i.mainId, deviceId: i.deviceId,
    workerInstallationId: i.workerInstallationId, keyRevision: i.keyRevision, authorizationRevision: i.authorizationRevision,
    bootId: i.bootId, connectionEpoch: i.connectionEpoch })
  const store = new RsyncPrivateStore(config.localRoot, { reserve: async () => async () => {}, retire: async () => {} })
  const reports: unknown[] = []
  // Readiness precedes all remote test mutation. No grants/services/network configuration touched.
  await ssh('id -u; test -d /home/builder/.local/share; test -x ' + remoteBinary)
  await ssh(`umask 077; mkdir -p -- ${remoteRoot}; test -d ${remoteRoot}`)
  try {
    for (const size of [0, 1048576, 8388608]) {
      const data = randomBytes(size), sha256 = createHash('sha256').update(data).digest('hex'), id = randomUUID()
      const i: TransferIntent = { version: 1, transferId: id, operationId: randomUUID(), mainId: randomUUID(), deviceId: randomUUID(),
        workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID(),
        executionId: randomUUID(), attemptId: randomUUID(), placementHash: 'a'.repeat(64), rootId: randomUUID(), rootBindingRevision: 1,
        direction: 'to-worker', byteClass: 'artifact', sha256, byteSize: size, manifestDigest: 'b'.repeat(64),
        expiresAt: new Date(Date.now() + 120000).toISOString(), chunkBytes: 1048576 }
      const inputPath = join(root, `${id}.input`); await writeFile(inputPath, data, { mode: 0o600 })
      const source = await open(inputPath, 'r')
      // Freeze before mutation; transport must never read the subsequent original work-file bytes.
      const sealed = await store.freeze(i, source, signal); await sealed.close()
      await writeFile(inputPath, Buffer.alloc(size, 17))
      const verifyRemote = async (path: string) => {
        const output = await ssh(`/usr/bin/sha256sum -- ${path}; /usr/bin/wc -c < ${path}`)
        const lines = output.trim().split('\n')
        expect(lines[0]).toBe(`${sha256}  ${path}`); expect(Number(lines[1])).toBe(size)
      }
      let corruptBeforeVerify = false
      const ports: RsyncStagingPorts = {
        source: async () => store.freeze(i, source, signal),
        receiver: async () => {
          // Immutable accepted identity fixture. Real composition uses existing app control RPC/quota.
          return { interrupt: async () => {}, verify: async () => {
            if (corruptBeforeVerify) await ssh(`printf x > ${remoteRoot}/${id}.part`)
            await verifyRemote(`${remoteRoot}/${id}.part`)
            return { intent: i, sha256, byteSize: size, read: async () => { throw new Error('Worker canonical consumer integration-owned') }, close: async () => {} }
          } }
        },
      }
      let interrupted = false, partialBytes = 0
      if (size === 8388608) {
        const abort = new AbortController()
        const limited: RsyncExecutor = { run: (command, bounded) => {
          if (command.args.includes('--partial')) {
            setTimeout(() => abort.abort(new Error('physical cancellation')), 1300)
            return executor.run({ ...command, args: ['--bwlimit=256', ...command.args] }, bounded)
          }
          return executor.run(command, bounded)
        } }
        const before = Date.now()
        await expect(new RsyncStagingTransport(config, { authorize: async () => {} }, ports, limited)
          .stage(i, async () => context(i), abort.signal)).rejects.toThrow('physical cancellation')
        expect(Date.now() - before).toBeLessThan(8000); interrupted = true
        const result = await ssh(`if test -f ${remoteRoot}/.rsync-partial/${id}.part; then /usr/bin/wc -c < ${remoteRoot}/.rsync-partial/${id}.part; else echo 0; fi`)
        partialBytes = Number(result.trim()); expect(partialBytes).toBeGreaterThan(0); expect(partialBytes).toBeLessThan(size)
      }
      const start = Date.now()
      const staged = await new RsyncStagingTransport(config, { authorize: async () => {} }, ports, executor).stage(i, async () => context(i))
      await staged.close()
      let corruptionRejected = false
      if (size === 1048576) {
        corruptBeforeVerify = true
        await expect(new RsyncStagingTransport(config, { authorize: async () => {} }, ports, executor)
          .stage(i, async () => context(i))).rejects.toThrow()
        corruptionRejected = true; corruptBeforeVerify = false
        const restored = await new RsyncStagingTransport(config, { authorize: async () => {} }, ports, executor)
          .stage(i, async () => context(i)); await restored.close()
      }
      await source.close()
      const pushMs = Date.now() - start
      await ssh(`cp -- ${remoteRoot}/${id}.part ${remoteRoot}/${id}.snapshot; chmod 400 -- ${remoteRoot}/${id}.snapshot`)
      const pull = { ...i, direction: 'to-main' as const }
      // Independent receiver journal must bind pull direction, not reuse the push source-store identity.
      const pullStore = new RsyncPrivateStore(join(root, 'pull'), { reserve: async () => async () => {}, retire: async () => {} })
      const pullConfig = { ...config, localRoot: pullStore.root }
      const pullPorts: RsyncStagingPorts = { source: async () => ({ verify: async () => verifyRemote(`${remoteRoot}/${id}.snapshot`), close: async () => {} }),
        receiver: async () => pullStore.receive(pull, signal) }
      const returned = await new RsyncStagingTransport(pullConfig, { authorize: async () => {} }, pullPorts, executor)
        .stage(pull, async () => context(pull))
      expect(await readFile(join(pullStore.root, `${id}.part`))).toEqual(data)
      await returned.close(); await pullStore.retire(pull); await store.retire(i)
      reports.push({ size, sha256, interrupted, partialBytes, corruptionRejected, pushMs, remoteSha256: sha256, returnedSha256: sha256 })
    }
    const output = process.env.RSYNC_PHYSICAL_REPORT
    if (output) await writeFile(output, JSON.stringify({ run, localBinary: binary, localBinarySha256: binaryHash,
      remoteBinary, remoteBinarySha256: remoteHash, reports, publication: 'unrun-integration-owned' }, null, 2))
    console.log(JSON.stringify(reports))
  } finally {
    await ssh(`rm -rf -- ${remoteRoot}`)
    await rm(root, { recursive: true, force: true })
  }
}, 180000)
