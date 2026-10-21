import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type pg from 'pg'
import { DEFAULT_HARNESS_DEFAULTS, OperatorConfigurationVersionSchema } from '@foreman-code/contracts'
import type { AcceptedProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import type { ApiConfig } from '../../../config.js'
import type { NativeHarnessFactories, NativeHarnessAllocation } from '../runtimeFactory.js'
import type { NativeHarnessSessionManager } from '../port.js'
import type { NativeResponseJournal } from '../recovery/responseJournal.js'
import { productionOperatorManagers } from './managers.js'

it.each(['slot', 'legacy-profile'] as const)('passes the accepted %s binding into unprofiled Codex Operator allocation', kind => {
  const accountId = randomUUID()
  const mainId = randomUUID()
  const binding: AcceptedProviderAccountBinding = kind === 'slot' ? {
    kind, accountId, provider: 'codex', profileRef: accountId, bindingRevision: 1, subject: null,
    target: { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
      keyRevision: null, authorizationRevision: null },
  } : { kind, accountId, provider: 'codex', target: null, profileRef: null, historicalSubject: 'unknown' }
  const manager = {} as NativeHarnessSessionManager
  const allocate = vi.fn<(allocation: NativeHarnessAllocation) => { harness: 'codex'; manager: NativeHarnessSessionManager }>(
    () => ({ harness: 'codex', manager }))
  const configuration = OperatorConfigurationVersionSchema.parse({ id: randomUUID(), operatorId: randomUUID(),
    version: 1, harness: { ...DEFAULT_HARNESS_DEFAULTS.codex, accountId }, contentHash: 'sha256:' + '1'.repeat(64),
    createdAt: '2026-01-01T00:00:00.000Z' })
  const resolver = productionOperatorManagers({ app: () => { throw new Error('No file access was requested') },
    pool: {} as pg.Pool, config: { harnesses: { workspaceRoot: '/fixture/workflows', timeoutMs: 1000,
      codexBinary: '/fixture/codex' } } as ApiConfig,
    workingDirectory: '/fixture/workspace', managers: new Map(), responseJournal: {} as NativeResponseJournal,
    processRegistry: { scope: owner => ({ owner, root: '/fixture/processes' }), closeOwner: async () => true },
    nativeFactories: { allocate } as unknown as NativeHarnessFactories,
    accountBinding: () => binding,
  })
  expect(resolver(configuration, 'accepted-conversation')).toBe(manager)
  expect(allocate.mock.calls[0]![0].accountBinding).toEqual(binding)
  expect(allocate.mock.calls[0]![0].configured!.configuration).toEqual(configuration.harness)
  expect(resolver(configuration, 'accepted-conversation')).toBe(manager)
  expect(allocate).toHaveBeenCalledTimes(1)
})
