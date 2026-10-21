import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { PodmanCommandRunner } from './executorPodman.js'
import { OwnedOCIContainer, parseOCIProcessStat, type OCIContainerOwnership } from './executorContainerOwner.js'

const boot = '00000000-0000-4000-8000-000000000001'
describe('original OCI owner identity checks, no container or PID signals', () => {
  it.each(['created', 'configured'])('removes an owned %s container only after helpers close, including retries', async status => {
    const containerId = 'd'.repeat(64)
    let present = true
    const ownership = { assertCurrent: vi.fn(), bindContainer: vi.fn(), readCertificate: async () => null,
      closeHelpers: vi.fn(async () => true), confirmUnreleasedClosure: vi.fn(async () => true),
    } as unknown as OCIContainerOwnership
    const commands = { run: vi.fn(async (argv: string[]) => {
      if (argv[0] === 'rm') {
        present = false
        return { exitCode: 0, stdout: containerId }
      }
      if (argv[1] === 'exists' || !present) return { exitCode: present ? 0 : 1, stdout: '' }
      return { exitCode: 0, stdout: JSON.stringify([{ Id: containerId,
        Config: { Labels: { owner: 'original' } }, State: { Running: false, Pid: 0, Status: status } }]) }
    }) }
    const restore = () => new OwnedOCIContainer({ identity: 'original', labels: { owner: 'original' },
      originalContainerId: containerId }, commands, ownership)
    await restore().remove()
    await restore().remove()
    expect(present).toBe(false)
    expect(commands.run.mock.calls.filter(([argv]) => argv[0] === 'rm')).toHaveLength(1)
    expect(ownership.closeHelpers).toHaveBeenCalled()
    expect(ownership.confirmUnreleasedClosure).toHaveBeenCalledWith(containerId)
    expect(commands.run.mock.calls.some(([argv]) => ['start', 'stop', 'kill'].includes(argv[0]!))).toBe(false)
  })

  it.each([false, true])('keeps a never-started container when helper closure is %s and release proof fails', async helpersClosed => {
    const containerId = 'd'.repeat(64)
    const ownership = { assertCurrent: vi.fn(), readCertificate: async () => null,
      closeHelpers: async () => helpersClosed, confirmUnreleasedClosure: async () => false,
    } as unknown as OCIContainerOwnership
    const commands = { run: vi.fn<PodmanCommandRunner['run']>(async () => ({ exitCode: 0, stdout: JSON.stringify([{ Id: containerId,
      Config: { Labels: { owner: 'original' } }, State: { Running: false, Pid: 0, Status: 'created' } }]) })) }
    const owner = new OwnedOCIContainer({ identity: 'original', labels: { owner: 'original' },
      originalContainerId: containerId }, commands, ownership)
    await expect(owner.remove()).rejects.toThrow('closure is unconfirmed')
    expect(commands.run.mock.calls.some(([argv]) => argv[0] === 'rm')).toBe(false)
  })

  it('rechecks a never-started container after helper closure before confirming removal', async () => {
    const containerId = 'd'.repeat(64)
    let running = false
    const ownership = { assertCurrent: vi.fn(), readCertificate: async () => null,
      closeHelpers: async () => { running = true; return true }, confirmUnreleasedClosure: vi.fn(async () => true),
    } as unknown as OCIContainerOwnership
    const commands = { run: vi.fn<PodmanCommandRunner['run']>(async () => ({ exitCode: 0, stdout: JSON.stringify([{ Id: containerId,
      Config: { Labels: { owner: 'original' } },
      State: { Running: running, Pid: running ? 42 : 0, Status: running ? 'running' : 'created' } }]) })) }
    const owner = new OwnedOCIContainer({ identity: 'original', labels: { owner: 'original' },
      originalContainerId: containerId }, commands, ownership)
    expect(await owner.close(0)).toBe(false)
    expect(ownership.confirmUnreleasedClosure).not.toHaveBeenCalled()
  })

  it.each([1, 0, 125])('closes a failed unentered creation only with absent storage and the original native failure (exists %s)', async existsCode => {
    const confirmFailedCreation = vi.fn(async () => true)
    const ownership = { assertCurrent: vi.fn(), confirmFailedCreation } as unknown as OCIContainerOwnership
    const commands = { run: vi.fn(async (argv: string[]) => ({ exitCode: argv[1] === 'exists' ? existsCode : 125, stdout: '' })) }
    const owner = new OwnedOCIContainer({ identity: 'original', labels: { owner: 'original' } }, commands, ownership)
    expect(await owner.close(1)).toBe(existsCode === 1)
    if (existsCode === 1) {
      await owner.remove()
      expect(confirmFailedCreation).toHaveBeenCalledWith('original')
      expect(commands.run.mock.calls.some(([argv]) => argv[0] === 'rm')).toBe(false)
    } else expect(confirmFailedCreation).not.toHaveBeenCalled()
  })
  it('keeps absent storage uncertain when native creation failure is unconfirmed', async () => {
    const ownership = { assertCurrent: vi.fn(), confirmFailedCreation: async () => false } as unknown as OCIContainerOwnership
    const owner = new OwnedOCIContainer({ identity: 'original', labels: {} }, { run: async () => ({ exitCode: 1, stdout: '' }) }, ownership)
    await expect(owner.remove()).rejects.toThrow('closure is unconfirmed')
  })
  it.each([true, false])('removes only a confirmed closed container and recovers removal after restart (present %s)', async initiallyPresent => {
    const containerId = 'd'.repeat(64)
    const scope = { subject: { kind: 'job' as const, executionId: 'job', attemptId: 'attempt', operationId: 'operation', bindingHash: 'b'.repeat(64) },
      leaseId: 'lease', owner: { grantId: 'grant', epoch: '1' }, observedDeviceId: 'device', observedInstallationId: 'installed', bootId: boot }
    const certificate = { scope, containerId, process: { pid: 42, startTicks: '123', bootId: boot },
      boundary: { kind: 'cgroup-v2' as const, path: `/sys/fs/cgroup/foreman-closed-test-${randomUUID()}`, device: '1', inode: '2' },
      helpers: [], lifecycle: 'closed' as const }
    const ownership: OCIContainerOwnership = { scope, assertCurrent: vi.fn(), reserveContainerIntent: vi.fn(),
      bindContainer: vi.fn(), launchHelpers: async () => [], readCertificate: async () => certificate, publish: vi.fn() }
    let present = initiallyPresent
    let removals = 0
    const commands = { run: async (argv: string[]) => {
      if (argv[0] === 'rm') {
        present = false
        removals++
        return { exitCode: 0, stdout: containerId }
      }
      if (!present || argv[1] === 'exists') return { exitCode: present ? 0 : 1, stdout: '' }
      return { exitCode: 0, stdout: JSON.stringify([{ Id: containerId, Config: { Labels: { owner: 'original' } },
        State: { Running: false, Pid: 0, Status: 'exited' } }]) }
    } }
    const restore = () => new OwnedOCIContainer({ identity: 'original', labels: { owner: 'original' },
      originalContainerId: containerId }, commands, ownership)
    await restore().remove()
    expect(present).toBe(false)
    expect(await restore().close(0)).toBe(true)
    await restore().remove()
    expect(removals).toBe(Number(initiallyPresent))
  })

  it('does not treat missing container storage as a closed process without the original certificate', async () => {
    const ownership = { assertCurrent: vi.fn(), readCertificate: async () => null } as unknown as OCIContainerOwnership
    const commands = { run: async () => ({ exitCode: 1, stdout: '' }) }
    const owner = new OwnedOCIContainer({ identity: 'original', labels: { owner: 'original' },
      originalContainerId: 'd'.repeat(64) }, commands, ownership)
    await expect(owner.remove()).rejects.toThrow('closure is unconfirmed')
  })

  it('parses start ticks with spaces/parentheses in the kernel command name', () => {
    const fields = ['S', ...Array(18).fill('0'), '12345', '0']
    expect(parseOCIProcessStat(42, `42 (command (nested) name) ${fields.join(' ')}`, boot)).toEqual({ pid: 42, startTicks: '12345', bootId: boot })
    expect(() => parseOCIProcessStat(43, `42 (name) ${fields.join(' ')}`, boot)).toThrow()
    expect(() => parseOCIProcessStat(42, '42 (name) S 0', boot)).toThrow()
  })
  it('rejects foreign labels before binding any journal identity', async () => {
    const ownership = { assertCurrent: vi.fn(), bindContainer: vi.fn() } as unknown as OCIContainerOwnership
    const commands = { run: vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify([{ Id: 'a'.repeat(64), Config: { Labels: { owner: 'other' } } }]) })) }
    const owner = new OwnedOCIContainer({ identity: 'original', labels: { owner: 'original' } }, commands, ownership)
    await expect(owner.bind('a'.repeat(64))).rejects.toThrow('ownership labels')
    expect(ownership.bindContainer).not.toHaveBeenCalled()
    expect(commands.run).toHaveBeenCalledOnce()
  })
  it('missing original receipt is unconfirmed and never becomes a stop acknowledgment', async () => {
    const ownership = { assertCurrent: vi.fn() } as unknown as OCIContainerOwnership
    const commands = { run: vi.fn(async () => ({ exitCode: 1, stdout: '' })) }
    const owner = new OwnedOCIContainer({ identity: 'original', labels: { owner: 'original' } }, commands, ownership)
    expect(await owner.close(1)).toBe(false)
    expect(commands.run).toHaveBeenCalledWith(['container', 'inspect', 'original'])
  })
  it('an unbounded original conmon helper prevents closure even after the container exited', async () => {
    const containerId = 'a'.repeat(64)
    const scope = { subject: { kind: 'job' as const, executionId: 'job', attemptId: 'attempt', operationId: 'operation', bindingHash: 'b'.repeat(64) },
      leaseId: 'lease', owner: { grantId: 'grant', epoch: '1' }, observedDeviceId: 'device', observedInstallationId: 'installed', bootId: boot }
    const certificate = { scope, containerId, process: { pid: 42, startTicks: '123', bootId: boot },
      boundary: { kind: 'cgroup-v2' as const, path: '/sys/fs/cgroup/graphql-ci-test-absent-original-boundary', device: '1', inode: '2' },
      helpers: [{ kind: 'conmon' as const, process: { pid: 43, startTicks: '124', bootId: boot }, boundary: null }], lifecycle: 'active' as const }
    const ownership = { scope, assertCurrent: vi.fn(), bindContainer: vi.fn(), readCertificate: vi.fn(async () => certificate), publish: vi.fn() } as unknown as OCIContainerOwnership
    const commands = { run: vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify([{ Id: containerId, Config: { Labels: { owner: 'original' } },
      State: { Running: false, Pid: 0, Status: 'exited' } }]) })) }
    const owner = new OwnedOCIContainer({ identity: 'original', labels: { owner: 'original' } }, commands, ownership)
    expect(await owner.close(1)).toBe(false)
    expect(ownership.publish).toHaveBeenCalledWith({ ...certificate, lifecycle: 'closure-unconfirmed' })
  })
})
