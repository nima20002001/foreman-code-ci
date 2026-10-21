import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { NativeProcessRecovery } from '../../src/modules/harnesses/recovery/processRegistry.js'
import { expect } from 'vitest'
import { localHumanProxyRequest } from '@foreman-code/contracts/local-client-node'
import { buildApp } from '../../src/app.js'
import { PostgresLocalHumanAccess } from '../../src/modules/access/localHuman.js'
import { NativeProcessRegistry } from '../../src/modules/harnesses/recovery/processRegistry.js'
import { registerUserInteractions } from '../../src/routes/userInteractions.js'
import { currentOperatorIntegration } from './currentOperatorIntegration.js'
import { privateFixtureDirectory } from './privateFixtureDirectory.js'
import type { agent3Database } from './wave25Agent3.js'

export interface NativeHttpIsolationInput {
  script: string; directory: string; recovery: NativeProcessRecovery; owner: string; token: string
}

export async function nativeHttpIsolation(launch: (input: NativeHttpIsolationInput) => Promise<{
    exitCode: number | null; stdout: string; stderr: string
  }>, options: { databaseUrl?: string; database?: Awaited<ReturnType<typeof agent3Database>> } = {}) {
  const fixture = await currentOperatorIntegration(options)
  const directory = await privateFixtureDirectory('native-http-client-')
  const registry = new NativeProcessRegistry(join(directory, 'processes'))
  const owner = `http-client:${randomUUID()}`
  const recovery = await registry.reserveLaunch(owner)
  const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access: fixture.access, services: fixture.services },
    localHuman: new PostgresLocalHumanAccess(fixture.db.pool, fixture.access) })
  registerUserInteractions(app, fixture.service)
  const proxy = createServer((request, response) => {
    void localHumanProxyRequest(request, response, error => {
      if (error) { response.writeHead(500).end(); return }
      const forwarded = httpRequest(new URL(request.url!, origin), {
        method: request.method, headers: { ...request.headers, host: new URL(origin).host },
      }, upstream => {
        response.writeHead(upstream.statusCode!, upstream.headers)
        upstream.pipe(response)
      })
      forwarded.on('error', () => response.writeHead(502).end())
      request.pipe(forwarded)
    })
  })
  let origin = ''
  try {
    origin = await app.listen({ host: '127.0.0.1', port: 0 })
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
    const address = proxy.address()
    if (!address || typeof address === 'string') throw new Error('Expected a browser proxy port.')
    const proxyOrigin = `http://127.0.0.1:${address.port}`
    const reader = await fixture.access.issue({ name: 'Native read-only client', audience: 'operator',
      grants: [{ actions: ['settings:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
    const before = await fixture.services.settings.getWorkflowDefaults(fixture.writer.principal)
    const update = { commandId: randomUUID(), expectedRevision: before.revision,
      value: { approvalHandler: before.value.approvalHandler === 'user' ? 'orchestrator' : 'user' } }
    await fixture.engine.start(fixture.f.run.id)
    const interaction = (await fixture.pending())[0]!
    expect(interaction.approval.handler).toBe('user')
    const approval = { interactionId: interaction.id, expectedRevision: interaction.revision,
      optionId: interaction.responseOptions[0]!.optionId }
    const clientModule = createRequire(import.meta.url).resolve('@modelcontextprotocol/client')
    const script = `
      (async () => {
        const { Client, StreamableHTTPClientTransport } = await import(${JSON.stringify(clientModule)});
        const statuses = [];
        for (const origin of ${JSON.stringify([origin, proxyOrigin])}) {
          for (const headers of [{}, {origin:'http://127.0.0.1:5173','sec-fetch-site':'same-origin'}]) {
            for (const [path, method, body] of ${JSON.stringify([
              ['/api/management/settings/workflows', 'PUT', update],
              [`/api/user/interactions/${interaction.id}/respond`, 'POST', approval],
            ])}) {
              const response = await fetch(origin + path, {method,
                headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
              statuses.push(response.status); await response.body.cancel();
            }
          }
        }
        const client = new Client({name:'native-isolation-client',version:'1'});
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', ${JSON.stringify(origin)}),
          {authProvider:{token:async()=>process.env.FOREMAN_CODE_MCP_TOKEN}}));
        const tools = await client.listTools();
        const read = await client.callTool({name:'workflow_defaults_get',arguments:{}});
        let denied;
        try { denied = await client.callTool({name:'workflow_defaults_update',arguments:${JSON.stringify(update)}}); }
        catch(error) { denied = {rpcErrorCode:error.code}; }
        await client.close();
        console.log(JSON.stringify({statuses,read,denied,mutationListed:tools.tools.some(tool=>tool.name==='workflow_defaults_update')}));
      })().catch(error => { console.error(error.message); process.exitCode=1; });
    `
    const result = await launch({ script, directory, owner, token: reader.token,
      recovery })
    expect(result.exitCode, result.stderr).toBe(0)
    const observed = JSON.parse(result.stdout)
    expect(observed.statuses).toEqual(Array(8).fill(403))
    expect(observed.read.isError).not.toBe(true)
    expect(decodeMcpToolResult(observed.read)).toEqual(before)
    expect(observed.mutationListed).toBe(false)
    if (observed.denied.rpcErrorCode !== undefined) {
      expect([-32601, -32602]).toContain(observed.denied.rpcErrorCode)
    } else {
      expect(observed.denied.isError).toBe(true)
    }
    expect(await fixture.services.settings.getWorkflowDefaults(fixture.writer.principal)).toEqual(before)
    expect(await fixture.service.get(interaction.id)).toEqual(interaction)
    expect(fixture.provider.counts.responses).toBe(0)
    for (const target of [origin, proxyOrigin]) {
      const human = await fetch(`${target}/api/management/settings/workflows`)
      expect(human.status).toBe(200)
      expect(await human.json()).toEqual(before)
    }
    const humanWrite = await fetch(`${proxyOrigin}/api/management/settings/workflows`, { method: 'PUT',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(update) })
    expect(humanWrite.status).toBe(200)
    expect((await fixture.services.settings.getWorkflowDefaults(fixture.writer.principal)).value).toEqual(update.value)
    const humanApproval = await fetch(`${proxyOrigin}/api/user/interactions/${interaction.id}/respond`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(approval),
    })
    expect(humanApproval.status).toBe(200)
    expect((await fixture.service.get(interaction.id)).selectedOptionId).toBe(approval.optionId)
  } finally {
    if (recovery.launchId) await registry.abandonReservedLaunch(recovery)
    await registry.closeOwner(owner)
    await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()))
    await app.close()
    await fixture.close()
    await rm(directory, { recursive: true, force: true })
  }
}
