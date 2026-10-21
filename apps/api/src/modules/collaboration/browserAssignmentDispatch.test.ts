import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { expect, it, vi } from 'vitest'
import type { AgentSubject } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { BrowserSubjectAuthority } from '../browser-runtime/types.js'
import { BrowserAuthority } from './browserAuthority.js'
import type { MainBrowserPairing } from './browserPairing.js'
import { createMainBrowserRemote } from './browserRemote.js'
import { createInstalledBrowserComposition } from './workerBrowser.js'

it('checks a Worker session profile against the assignment accepted by Main', async () => {
  const pool = new pg.Pool()
  const saved = makeCurrentWorkflowFixture('browser-assignment', 'single')
  const configuration = saved.configurations[0]!
  const subject: AgentSubject = { kind: 'conversation', conversationId: 'conversation', agent: {
    workspaceId: configuration.workspaceId, workflowId: saved.scope.workflowId,
    workflowNodeId: saved.version.definition.nodes[0]!.id, agentId: configuration.agentId,
    productRole: 'coder', displayName: 'Builder', configurationVersionId: configuration.id,
  } }
  const binding: DeviceSessionBinding = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1, connectionEpoch: randomUUID() }
  const authority = new BrowserAuthority(pool, () => binding.mainId,
    () => { throw new Error('Dispatch does not query profile readiness') }, async () => true)
  let profileId = 'first-profile'
  const details = vi.spyOn(authority, 'details').mockImplementation(async candidate => ({ subject: candidate, configuration,
    browser: { enabled: true, profileId }, workflowVersionId: saved.version.id,
    computerId: binding.deviceId, active: true, readOnly: false, tools: [] }))
  const main = createMainBrowserRemote({ pool, authority,
    pairing: { assertCurrent: async () => undefined } as unknown as MainBrowserPairing,
    endpoint: () => { throw new Error('Main dispatch is not required') },
    browser: () => { throw new Error('Viewer state is not required') }, reportFailure: error => { throw error } })
  let workerAuthority: BrowserSubjectAuthority | undefined
  const worker = createInstalledBrowserComposition({ stateDirectory: '/fixture/browser', root: '/fixture/runtime', facts: {},
    installationId: binding.workerInstallationId, computerId: binding.deviceId,
    connection: () => ({ currentBinding: () => binding, captureRequest: () => ({ binding,
      request: raw => main.handle(raw, { binding, signal: new AbortController().signal }) }) }),
    readPairing: async () => { throw new Error('Media pairing is not required') },
    assertHostOwnership: async () => undefined, reportFailure: error => { throw error },
    createRuntime: options => {
      workerAuthority = options.subjectAuthority
      return { start: async () => undefined, retry: async () => undefined, close: async () => undefined,
        stop: async () => undefined, restoreProfiles: async () => undefined,
        status: () => ({ ready: false, phase: 'unavailable' }), getHost: () => null,
        stopAdmission: () => undefined, resumeAdmission: async () => undefined, drain: async () => undefined }
    },
    createExtension: () => ({ command: async () => undefined, upload: async () => undefined,
      download: async () => { throw new Error('Downloads are not required') },
      media: async () => undefined, close: () => undefined }),
  })
  try {
    await expect(workerAuthority!.assertCurrent(subject, { profileId: 'first-profile' })).resolves.toBeUndefined()
    profileId = 'replacement-profile'
    await expect(workerAuthority!.assertCurrent(subject, { profileId: 'first-profile' }))
      .rejects.toMatchObject({ code: 'BROWSER_SCOPE_MISMATCH' })
    await expect(workerAuthority!.assertCurrent(subject, { profileId })).resolves.toBeUndefined()
  } finally { await worker.close(); main.close(); details.mockRestore(); await pool.end() }
})
