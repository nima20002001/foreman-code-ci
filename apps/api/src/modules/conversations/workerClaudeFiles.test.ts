import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { fileToolFixture } from '../../../test/support/fileTools.js'
import { ClaudeFileBridge } from '../harnesses/claudeSdk/files.js'
import type { ClaudeNativeSessionManager } from '../harnesses/claudeSdk/sessionManager.js'
import { createWorkerClaudeFiles } from './workerClaudeFiles.js'
import { rejectableDeferred } from '../../../test/helpers/deferred.js'

async function fixture() {
  const f = await fileToolFixture()
  const identity = { ownerPrincipalId: f.context.ownerPrincipalId, attemptId: 'request',
    nativeSessionId: f.context.nativeSessionId, nativeMessageId: 'message',
    clientCorrelationId: 'correlation', generation: 'query', toolUseId: 'root-tool' }
  const context = { nativeSessionId: identity.nativeSessionId, nativeMessageId: identity.nativeMessageId,
    clientCorrelationId: identity.clientCorrelationId, generation: identity.generation }
  const lifetime = new AbortController()
  const admission = { current: vi.fn(async () => ({
    context: { ...f.context, turnId: undefined, nativeMessageId: identity.nativeMessageId },
    expiresAt: new Date(f.clock().getTime() + 60_000),
  })) }
  const bridge = new ClaudeFileBridge(identity, admission, f.service)
  const completed = rejectableDeferred()
  let callSignal: AbortSignal | undefined
  const manager = { waitNativeCallbackContext: async () => context,
    nativeCallbackContext: () => context,
    callbackAuthority: () => ({ ownerPrincipalId: identity.ownerPrincipalId, attemptId: identity.attemptId }),
  } as unknown as ClaudeNativeSessionManager
  const adapter = createWorkerClaudeFiles({ sdk: { createSdkMcpServer, tool }, allowMutation: true,
    signal: lifetime.signal, manager: () => manager,
    authority: { file: async (_identity, operation, args, signal) => {
      callSignal = signal
      try { return await bridge.call(operation, args, signal) }
      finally { completed.resolve() }
    } },
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'worker-file-cancellation', version: '1.0.0' })
  await adapter.server.instance.connect(serverTransport)
  await client.connect(clientTransport)
  const source = await f.upload()
  const copy = (signal?: AbortSignal) => client.callTool({ name: 'files.create_working_copy',
    arguments: { commandId: randomUUID(), source, destination: f.scope },
    _meta: { 'claudecode/toolUseId': identity.toolUseId },
  }, undefined, { ...(signal ? { signal } : {}) })
  return { ...f, admission, bridge, client, lifetime, completed, copy, callSignal: () => callSignal,
    async close() {
      lifetime.abort()
      try { await adapter.close() }
      finally { try { await client.close() } finally { await bridge.close() } }
    },
  }
}

it.each(['tool', 'owner'] as const)('cancels a %s request held before file admission without creating an artifact', async kind => {
  const f = await fixture()
  const entered = rejectableDeferred()
  const release = rejectableDeferred()
  const current = f.admission.current.getMockImplementation()!
  f.admission.current.mockImplementationOnce(async () => {
    entered.resolve()
    await release.promise
    return current()
  })
  const controller = new AbortController()
  const result = f.copy(controller.signal).catch(error => error)
  try {
    await Promise.race([entered.promise, result.then(() => {
      throw new Error('The file call ended before the admission barrier.')
    })])
    if (kind === 'tool') controller.abort()
    else f.lifetime.abort()
    await vi.waitFor(() => expect(f.callSignal()?.aborted).toBe(true))
    release.resolve()
    await result
    await f.completed.promise
    expect(f.tools.artifacts.size).toBe(0)
    expect(f.tools.copies.size).toBe(0)
    if (kind === 'tool') {
      expect((await f.copy()).isError).not.toBe(true)
      expect(f.tools.copies.size).toBe(1)
    }
  } finally {
    release.resolve()
    if (f.callSignal()) await f.completed.promise
    await f.close()
  }
})

it('cancels during credential issuance before dispatch and revokes the issued credential on close', async () => {
  const f = await fixture()
  const entered = rejectableDeferred()
  const release = rejectableDeferred()
  const issue = f.sessions.issueForAcceptedSession.bind(f.sessions)
  const issuance = vi.spyOn(f.sessions, 'issueForAcceptedSession').mockImplementationOnce(async (...args) => {
    const token = await issue(...args)
    entered.resolve()
    await release.promise
    return token
  })
  const result = f.copy()
  try {
    await Promise.race([entered.promise, result.then(() => {
      throw new Error('The file call ended before the credential issuance barrier.')
    })])
    f.lifetime.abort()
    release.resolve()
    expect((await result).isError).toBe(true)
    expect(f.tools.artifacts.size).toBe(0)
    const issued = await issuance.mock.results[0]!.value
    await f.bridge.close()
    await expect(f.sessions.authenticate(issued)).rejects.toMatchObject({ code: 'FILE_SESSION_EXPIRED' })
    await expect(f.sessions.authenticate(f.token)).resolves.toMatchObject({ principal: f.principal })
  } finally {
    release.resolve()
    await f.close()
    issuance.mockRestore()
  }
})

it('keeps an accepted file mutation after cancellation and denies a revoked caller', async () => {
  const f = await fixture()
  const create = f.service.createWorkingCopy.bind(f.service)
  vi.spyOn(f.service, 'createWorkingCopy').mockImplementationOnce(async (...args) => {
    const result = await create(...args)
    f.lifetime.abort()
    return result
  })
  try {
    expect((await f.copy()).isError).not.toBe(true)
    expect(f.tools.copies.size).toBe(1)
    await f.bridge.close()
    expect(f.tools.copies.size).toBe(1)
  } finally { await f.close() }

  const revoked = await fixture()
  const entered = rejectableDeferred()
  const release = rejectableDeferred()
  const current = revoked.admission.current.getMockImplementation()!
  revoked.admission.current.mockImplementationOnce(async () => {
    entered.resolve()
    await release.promise
    return current()
  })
  const result = revoked.copy()
  try {
    await Promise.race([entered.promise, result.then(() => {
      throw new Error('The file call ended before the admission barrier.')
    })])
    revoked.revoke()
    release.resolve()
    expect((await result).isError).toBe(true)
    expect(revoked.tools.artifacts.size).toBe(0)
  } finally {
    release.resolve()
    await revoked.close()
  }
})
