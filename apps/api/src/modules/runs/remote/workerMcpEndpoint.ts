import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { registerAppRoute } from '../../harnesses/appMcpLauncher.js'
import type { ChildProcessEnvironment } from '../../harnesses/port.js'
import { readProductEnvironment } from '@foreman-code/contracts/product-environment'
import { AgentFilePublishInputSchema, AgentFilePublishResultSchema, type AgentFilePublishInput, type AgentFilePublishResult } from '@foreman-code/contracts/files'
import { TransferIntentSchema } from '@foreman-code/contracts/byte-transfer'
import { WORKER_MCP_REQUEST_MAX_BYTES, WorkerMcpRelayResponseSchema } from '@foreman-code/contracts/worker-mcp-relay'
import { z } from 'zod'
import { componentLogger } from '../../diagnostics/logger.js'
import { DeviceApplicationError, deviceApplicationFailure } from '../../devices/deviceApplicationError.js'
import { DeviceConnectionError } from '../../devices/deviceWire.js'
import { leaseFailureCause, renewOwnedLeases } from '../../leases/ownerLeases.js'

const PublicationCall = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]),
  method: z.literal('tools/call'), params: z.object({ name: z.literal('files.publish_transferred_result'),
    arguments: z.object({ transferId: TransferIntentSchema.shape.transferId, publication: AgentFilePublishInputSchema }).strict() }) })
const PublicationReply = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]),
  result: z.object({ isError: z.boolean().optional(), structuredContent: AgentFilePublishResultSchema }) })

/** Called only on the authenticated Main relay response, before forwarding it
 * to the native client. Model text and arbitrary loopback responses are absent. */
export function observedWorkflowArtifactPublication(body: unknown, response: z.infer<typeof WorkerMcpRelayResponseSchema>) {
  const call = PublicationCall.safeParse(body)
  if (!call.success || response.statusCode !== 200 || response.contentType === 'empty') return undefined
  const messages = response.contentType === 'application/json' ? [response.body]
    : response.body.split(/\r?\n\r?\n/).map(event => event.split(/\r?\n/)
      .filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')).filter(Boolean)
  const replies = messages.flatMap(message => {
    try { const reply = PublicationReply.safeParse(JSON.parse(message)); return reply.success ? [reply.data] : [] }
    catch { return [] }
  }).filter(reply => reply.id === call.data.id && !reply.result.isError)
  if (replies.length !== 1) return undefined
  return { input: call.data.params.arguments, result: replies[0]!.result.structuredContent }
}

const RelayedToolCall = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]),
  method: z.literal('tools/call') }).passthrough()

/** A tool call the Main relay could not complete is answered as a JSON-RPC error naming the failure and whether a
 * retry can help. A bare HTTP 502 reached the Agent as a generic "service unavailable" and hid both. */
export function relayFailureReply(body: unknown, error: unknown) {
  const call = RelayedToolCall.safeParse(body)
  if (!call.success) return undefined
  const known = error instanceof DeviceApplicationError || error instanceof DeviceConnectionError
  const code = known ? error.code : 'relay_failed'
  const retryable = error instanceof DeviceConnectionError || deviceApplicationFailure(error).retryable
  const cause = code === 'timeout' ? 'Foreman Main did not answer in time'
    : code === 'transport' ? 'the Worker lost its link to Foreman Main'
      : code === 'backpressure' ? 'the Worker link to Foreman Main is busy'
        : `Foreman Main refused the call (${code})`
  const message = `The Foreman Code MCP relay failed: ${cause}. ` + (retryable
    ? 'The call may still have run on Main: read back the result of any write, then retry this call.'
    : 'Retrying the same call will fail the same way.')
  return { jsonrpc: '2.0' as const, id: call.data.id, error: { code: -32000, message,
    data: { kind: retryable ? 'relay_unavailable' : 'relay_refused', code, retryable, delivery: 'indeterminate' } } }
}

/** Main answered the lease request and refused it (revoked credential, ended attempt); asking again cannot help. */
export function isLeaseRefusal(error: unknown): error is DeviceApplicationError {
  return error instanceof DeviceApplicationError && !error.retryable && error.code !== 'cancelled'
}

/** The admitted worker owns this private route until its original native owner closes.
 * Main reauthorizes every relayed request; neither this endpoint nor its route file grants access. */
export interface WorkerMcpRelay {
  environment: ChildProcessEnvironment
  expiresAt: string
  request(body: unknown, protocolVersion?: string, signal?: AbortSignal): Promise<z.infer<typeof WorkerMcpRelayResponseSchema>>
  /** Renews the same scoped lease with Main and returns its new expiry. */
  refresh?(signal?: AbortSignal): Promise<string>
}

/** A bound route renews itself this long before it expires, without waiting for a Main status frame.
 * Main renews the credential earlier (WORKER_CREDENTIAL_RENEWAL_WINDOW_MS), so this reads an extended expiry. */
export const WORKER_MCP_LEASE_RENEWAL_WINDOW_MS = 2 * 60_000

interface WorkerMcpEndpointOptions {
  launcher: string
  signal: AbortSignal
  /** Uses the relay expiry's clock domain; remote workflows supply sampled Main time. */
  now?: () => number
  onArtifactPublication?(input: { transferId: string; publication: AgentFilePublishInput }, result: AgentFilePublishResult): void
}
export interface WorkerMcpEndpoint {
  endpoint: string
  bindRelay(relay: WorkerMcpRelay): Promise<void>
  refreshLease(): Promise<string>
  close(): Promise<void>
}

export async function createWorkerMcpEndpoint(input: WorkerMcpEndpointOptions & { relay: WorkerMcpRelay }): Promise<WorkerMcpEndpoint> {
  const endpoint = await createUnboundWorkerMcpEndpoint(input)
  try { await endpoint.bindRelay(input.relay); return endpoint }
  catch (error) { await endpoint.close(); throw error }
}

/** Inspection keeps a stable native URL; requests remain unauthorized until Main supplies its scoped lease. */
export async function createUnboundWorkerMcpEndpoint(input: WorkerMcpEndpointOptions) {
  input.signal.throwIfAborted()
  const now = input.now ?? (() => Date.now())
  const lifetime = new AbortController()
  const signal = AbortSignal.any([input.signal, lifetime.signal])
  const log = componentLogger('harness')
  const logFailure = (operation: string, error: unknown) => {
    log.error({ operation, launcher: input.launcher,
      code: error instanceof Error && 'code' in error ? error.code : undefined,
      errorType: error instanceof Error ? error.name : typeof error }, 'Worker MCP relay failed')
  }
  let bound: { relay: WorkerMcpRelay; digest: Buffer; expiresAt: string; refused?: DeviceApplicationError } | undefined
  const active = new Set<Promise<void>>()
  let closing = false, shutdown: Promise<void> | undefined
  const server = createServer((request, response) => {
    let body: unknown
    const task = (async () => {
      response.setHeader('cache-control', 'no-store')
      const lease = bound
      if (closing || signal.aborted || !lease || Date.parse(lease.expiresAt) <= now()
        || !timingSafeEqual(lease.digest, createHash('sha256').update(request.headers.authorization ?? '').digest())) {
        response.writeHead(401); response.end(); return
      }
      if (request.method !== 'POST' || request.url !== '/mcp') { response.writeHead(405); response.end(); return }
      const controller = new AbortController()
      const requestSignal = AbortSignal.any([signal, controller.signal])
      const disconnected = () => controller.abort()
      request.once('aborted', disconnected)
      response.once('close', disconnected)
      try {
        let byteSize = 0
        const chunks: Buffer[] = []
        for await (const chunk of request) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          byteSize += bytes.byteLength
          if (byteSize > WORKER_MCP_REQUEST_MAX_BYTES) { response.writeHead(413); response.end(); return }
          chunks.push(bytes)
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
        catch { response.writeHead(400); response.end(); return }
        const protocol = request.headers['mcp-protocol-version']
        if (Array.isArray(protocol) || (protocol?.length ?? 0) > 64) { response.writeHead(400); response.end(); return }
        requestSignal.throwIfAborted()
        const result = await lease.relay.request(body, protocol, requestSignal)
        if (bound !== lease || closing) throw new Error('The Main MCP lease changed during the request.')
        requestSignal.throwIfAborted()
        const publication = input.onArtifactPublication && observedWorkflowArtifactPublication(body, result)
        if (publication) input.onArtifactPublication!(publication.input, publication.result)
        response.writeHead(result.statusCode, result.contentType === 'empty' ? {} : { 'content-type': result.contentType })
        response.end(result.body)
      } finally { request.removeListener('aborted', disconnected); response.removeListener('close', disconnected) }
    })().catch(error => {
      logFailure('request', error)
      const reply = !response.headersSent ? relayFailureReply(body, error) : undefined
      if (reply) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(reply))
        return
      }
      if (!response.headersSent) response.writeHead(502)
      response.end()
    })
    active.add(task)
    void task.then(() => active.delete(task))
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 1000
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() }) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The private worker MCP listener is unavailable.')
  const endpoint = `http://127.0.0.1:${address.port}/mcp`
  let unregister: (() => Promise<void>) | undefined
  const close = () => shutdown ??= (async () => {
    closing = true
    lifetime.abort()
    renewal?.abort()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await Promise.all([...active])
    await updates
    await unregister?.()
  })()
  let updates: Promise<void> = Promise.resolve()
  const bindRelay = (relay: WorkerMcpRelay) => {
    const task = updates.then(async () => {
      signal.throwIfAborted()
      const token = readProductEnvironment(relay.environment.variables, 'MCP_TOKEN')
      if (closing || !token || !Number.isFinite(Date.parse(relay.expiresAt)) || Date.parse(relay.expiresAt) <= now()) {
        throw new Error('The original Main MCP lease is unavailable.')
      }
      renewal?.abort()
      bound = undefined
      await unregister?.()
      unregister = undefined
      const release = await registerAppRoute(token, endpoint, relay.expiresAt, input.launcher, { now })
      if (closing || signal.aborted) {
        await release()
        throw new Error('The private worker MCP listener closed.')
      }
      unregister = release
      bound = { relay, digest: createHash('sha256').update(`Bearer ${token}`).digest(), expiresAt: relay.expiresAt }
      renewWhileBound(bound)
      log.info({ agentId: relay.environment.agentId, launcher: input.launcher, expiresAt: relay.expiresAt },
        'Worker MCP launcher route registered')
    }).catch(error => {
      logFailure('register', error)
      throw error
    })
    updates = task.then(() => undefined, () => undefined)
    return task
  }
  /** Refresh only in the renewal window; queued callers reuse the latest expiry. */
  const refreshLease = () => {
    let repeatedRefusal = false
    const task = updates.then(async () => {
      const lease = bound
      if (closing || !lease?.relay.refresh) throw new Error('The original worker MCP endpoint is closing.')
      if (Date.parse(lease.expiresAt) - now() > WORKER_MCP_LEASE_RENEWAL_WINDOW_MS) return lease.expiresAt
      // Main refused this lease for good (for example it ended the attempt and revoked the credential): asking
      // again cannot succeed, so later renewals report the logged refusal without another Main request.
      if (lease.refused) { repeatedRefusal = true; throw lease.refused }
      let renewedExpiry: string
      try { renewedExpiry = await lease.relay.refresh(signal) } catch (error) {
        if (isLeaseRefusal(error) && bound === lease) lease.refused = error
        throw error
      }
      signal.throwIfAborted()
      if (closing || bound !== lease) throw new Error('The original worker MCP endpoint is closing.')
      if (!Number.isFinite(Date.parse(renewedExpiry)) || Date.parse(renewedExpiry) <= now()) {
        throw new Error('The renewed Main MCP lease is unavailable.')
      }
      const token = readProductEnvironment(lease.relay.environment.variables, 'MCP_TOKEN')!
      unregister = await registerAppRoute(token, endpoint, renewedExpiry, input.launcher, { now })
      lease.expiresAt = renewedExpiry
      if (renewal?.signal.aborted) renewWhileBound(lease)
      log.debug({ agentId: lease.relay.environment.agentId, launcher: input.launcher, expiresAt: renewedExpiry },
        'Worker MCP launcher route renewed')
      return renewedExpiry
    }).catch(error => {
      if (!repeatedRefusal) logFailure('renew', error)
      throw error
    })
    updates = task.then(() => undefined, () => undefined)
    return task
  }
  /** The bound route is one lease of this attempt: it renews in its final window, so a long native turn never
   * depends on Main status frames, and stops when the endpoint closes, the lease is rebound, or Main refuses it. */
  let renewal: AbortController | undefined
  const renewWhileBound = (lease: NonNullable<typeof bound>) => {
    renewal?.abort()
    renewal = undefined
    if (!lease.relay.refresh) return
    const owner = new AbortController()
    renewal = owner
    void renewOwnedLeases({ signal: AbortSignal.any([owner.signal, signal]),
      leases: [{ name: 'Worker MCP route', renewWithinMs: WORKER_MCP_LEASE_RENEWAL_WINDOW_MS,
        remainingMs: () => bound === lease ? Date.parse(lease.expiresAt) - now() : NaN,
        renew: async () => { await refreshLease() } }],
      onFailure: error => {
        owner.abort()
        void reportRenewalFailure(lease, error, owner)
      },
    })
  }
  /** The route keeps its expiry but records why renewal stopped, so the launcher reports the real cause. */
  const reportRenewalFailure = (lease: NonNullable<typeof bound>, error: Error, owner: AbortController) => {
    const cause = leaseFailureCause(error)
    log.error({ operation: 'renewal stopped', launcher: input.launcher, agentId: lease.relay.environment.agentId,
      expiresAt: lease.expiresAt, cause }, 'Worker MCP route renewal stopped')
    const task = updates.then(async () => {
      if (closing || bound !== lease || renewal !== owner) return
      const token = readProductEnvironment(lease.relay.environment.variables, 'MCP_TOKEN')!
      unregister = await registerAppRoute(token, endpoint, lease.expiresAt, input.launcher, { now, renewalFailure: cause })
    }).catch(failure => logFailure('report renewal failure', failure))
    updates = task
    return task
  }
  const unbindRelay = () => {
    const task = updates.then(async () => {
      renewal?.abort()
      bound = undefined
      await unregister?.()
      unregister = undefined
    }).catch(error => {
      logFailure('unbind', error)
      throw error
    })
    updates = task.then(() => undefined, () => undefined)
    return task
  }
  return { endpoint, bindRelay, unbindRelay, refreshLease, close }
}
