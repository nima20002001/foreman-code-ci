import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NATIVE_INTERACTION_FIXTURES } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { describe, it } from 'vitest'

import { canReadInteraction, canRespondToInteraction } from '../src/modules/access/appPolicy.js'
import { decodeInteractionCursor } from '../src/modules/interactions/app.js'
import { McpDetectionService, WorkerLaunchCredentialService, endpointMatches, type NativeMcpEntryEvidence } from '../src/modules/harnesses/mcpDetection.js'
import { CodexAppServerSessionManager, type CodexSessionDependencies } from '../src/modules/harnesses/codexAppServer.js'
import { RECORDED_CODEX_VERSION } from './fixtures/codex-version.js'
import { HarnessExecutionError } from '../src/modules/harnesses/errors.js'
import { fixtureProtocol } from './fixtures/codex-test-helpers.js'
import { runCommand, runJsonlProcess } from '../src/modules/harnesses/process.js'
import { redactKnownSecrets, redactSecretText } from '../src/modules/harnesses/secrets.js'

const endpoint = 'http://127.0.0.1:3000/mcp'
const matching: NativeMcpEntryEvidence = {
  name: 'graphql', transport: 'streamable-http', endpoint,
  credentialEnvironmentVariable: 'GRAPHQL_MCP_TOKEN',
}
const context = { harness: 'codex' as const, runnerId: 'runner-local', workingDirectory: process.cwd() }
function detection(entry: NativeMcpEntryEvidence) {
  return new McpDetectionService({ inspect: async () => ({ ...context, providerVersion: '0.154.0', inspectedAt: new Date().toISOString(), entry }) }, endpoint)
}

describe('PR #11 secret and launch boundaries', () => {
  it('does not inherit an ambient App token into inspection commands', async () => {
    const previous = process.env.GRAPHQL_MCP_TOKEN
    process.env.GRAPHQL_MCP_TOKEN = 'ambient-pr11-secret'
    try {
      const result = await runCommand(process.execPath, ['-e', 'console.log(Boolean(process.env.GRAPHQL_MCP_TOKEN))'], process.cwd())
      assert.equal(result.stdout.trim(), 'false')
      assert.equal(process.env.GRAPHQL_MCP_TOKEN, 'ambient-pr11-secret')
    } finally {
      if (previous === undefined) delete process.env.GRAPHQL_MCP_TOKEN
      else process.env.GRAPHQL_MCP_TOKEN = previous
    }
  })

  it('redacts nested JSON, escaped JSON arrays, raw stdout, split stderr and returned stderr', async () => {
    const secret = 'scoped-pr11-secret-value'
    const events: unknown[] = []
    const result = await runJsonlProcess({
      binary: process.execPath,
      args: ['-e', `const value = process.env.GRAPHQL_MCP_TOKEN;
console.log(JSON.stringify({type:'proof', nested:[{unrelated:value}], [value]:value}));
console.log('raw ' + value);
console.log('["' + [...value].map(c => '\\\\u' + c.charCodeAt(0).toString(16).padStart(4,'0')).join('') + '"]');
process.stderr.write(value.slice(0, 7));
setTimeout(() => process.stderr.write(value.slice(7) + '\\n'), 10);`],
      cwd: process.cwd(), signal: new AbortController().signal,
      expectedAgentId: 'agent-a', beforeSpawn: async () => ({ agentId: 'agent-a', variables: { GRAPHQL_MCP_TOKEN: secret } }),
      onSpawn: () => undefined, onEvent: async (event) => { events.push(event) },
    })
    assert.equal(result.exitCode, 0)
    assert(!JSON.stringify({ events, stderr: result.stderr }).includes(secret))
    assert(result.stderr.includes('[REDACTED]'))
    const raw = events as Array<{ payload: { text?: string } }>
    const array = raw.find((event) => event.payload.text?.startsWith('['))?.payload.text
    assert.equal(array, '["[REDACTED]"]')
  })

  it('isolates concurrently injected Agent credentials and never puts them in argv', async () => {
    const output = await Promise.all(['agent-a', 'agent-b'].map(async (agentId) => {
      const events: unknown[] = []
      await runJsonlProcess({
        binary: process.execPath,
        args: ['-e', `console.log(JSON.stringify({type:'proof', suffix:process.env.GRAPHQL_MCP_TOKEN.endsWith(${JSON.stringify(agentId)}), argv:process.argv}))`],
        cwd: process.cwd(), signal: new AbortController().signal, expectedAgentId: agentId,
        beforeSpawn: async () => ({ agentId, variables: { GRAPHQL_MCP_TOKEN: `private-pr11-${agentId}` } }),
        onSpawn: () => undefined, onEvent: async (event) => { events.push(event) },
      })
      return events
    }))
    assert(!JSON.stringify(output).includes('private-pr11-'))
    for (const events of output) assert.equal((events[0] as { payload: { suffix: boolean } }).payload.suffix, true)
  })

  it('rejects the wrong environment owner before spawning', async () => {
    let spawned = false
    await assert.rejects(runJsonlProcess({
      binary: process.execPath, args: ['-e', ''], cwd: process.cwd(), signal: new AbortController().signal,
      expectedAgentId: 'agent-a', beforeSpawn: async () => ({ agentId: 'agent-b', variables: { GRAPHQL_MCP_TOKEN: 'private-pr11-other' } }),
      onSpawn: () => { spawned = true }, onEvent: async () => undefined,
    }), /another Agent/)
    assert.equal(spawned, false)
  })

  it('matches known values independent of field names and JSON escaping', () => {
    const secret = 'private-"-pr11-\\-value'
    assert.equal(redactSecretText(JSON.stringify([secret]), [secret]), '["[REDACTED]"]')
    assert.deepEqual(redactKnownSecrets({ nested: [{ unrelated: secret }], [secret]: secret }, [secret]), {
      nested: [{ unrelated: '[REDACTED]' }], '[REDACTED]': '[REDACTED]',
    })
  })

  it('cancels and drains a stuck native command', async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 50)
    try {
      await assert.rejects(runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], process.cwd(), controller.signal))
    } finally { clearTimeout(timer) }
  })
})

describe('PR #11 detection and authorization', () => {
  it('requires the exact route and rejects URL credentials', () => {
    assert(endpointMatches(endpoint, endpoint))
    for (const value of [endpoint + '/', endpoint + '?x=1', endpoint + '#fragment', endpoint.replace('127.0.0.1', 'user:password@127.0.0.1')]) {
      assert.equal(endpointMatches(value, endpoint), false)
    }
  })

  it('does not echo provider error text or native diagnostic strings', async () => {
    for (const text of ['token="private-pr11-value"', '{"token":"private-pr11-value"}', 'Authorization: Basic private-pr11-value']) {
      const service = new McpDetectionService({ inspect: async () => { throw new Error(text) } }, endpoint)
      const result = await service.inspect(context)
      assert.equal(result.detection.state, 'check_failed')
      assert(!JSON.stringify(result).includes('private-pr11-value'))
    }
    const result = await detection({ ...matching, detail: 'private-pr11-value', nativeFilterDiagnostics: ['private-pr11-value'] }).inspect(context)
    assert(!JSON.stringify(result).includes('private-pr11-value'))
    assert(result.nativeFilters.diagnostics?.length)
  })

  it('bounds an unresponsive inspector and propagates its cancellation signal', async () => {
    let observed: AbortSignal | undefined
    const service = new McpDetectionService({ inspect: async (input) => {
      observed = input.signal
      return new Promise(() => undefined)
    } }, endpoint, 'graphql', 25)
    const result = await service.inspect(context)
    assert.equal(result.detection.state, 'check_failed')
    assert.equal(observed?.aborted, true)
  })

  it('separates valid pre-injection authentication requirements from broken connections', async () => {
    assert.equal((await detection({ ...matching, status: 'authentication_required' }).preflight(context)).detection.state, 'authentication_required')
    await assert.rejects(detection({ ...matching, status: 'broken' }).preflight(context), { code: 'APP_MCP_PREFLIGHT_FAILED' })
    await assert.rejects(detection({ ...matching, status: 'authentication_required', credentialEnvironmentVariable: 'OTHER' }).preflight(context), { code: 'APP_MCP_PREFLIGHT_FAILED' })
  })

  it('rejects execution bounds that can outlive the issued credential', () => {
    assert.throws(() => new WorkerLaunchCredentialService(detection(matching), { ttlMs: 900_000 } as never, 'runner-local', 900_000), /30 seconds/)
    assert.doesNotThrow(() => new WorkerLaunchCredentialService(detection(matching), { ttlMs: 900_000 } as never, 'runner-local', 870_000))
  })

  it('rejects malformed decoded cursors before database access', () => {
    const encode = (id: string) => Buffer.from(`interaction:${id}`).toString('base64url')
    assert.equal(decodeInteractionCursor(encode('interaction-valid')), 'interaction-valid')
    for (const id of ['bad\0id', 'bad\nid', '\u0085bad', '', ' leading']) assert.throws(() => decodeInteractionCursor(encode(id)), { code: 'INVALID_CURSOR' })
    for (const value of ['*', encode('ok') + '=', Buffer.from([255, 254]).toString('base64url')]) assert.throws(() => decodeInteractionCursor(value), { code: 'INVALID_CURSOR' })
  })

  it('does not borrow respond permission or partial scope from another grant', () => {
    const principal: ManagementPrincipal = {
      id: 'principal-reviewer', name: 'reviewer', audience: 'worker', agentId: 'reviewer', revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      grants: [
        { actions: ['interactions:read', 'interactions:respond'], scope: { workspaceIds: ['workspace-a'], workflowIds: ['workflow-a'], runIds: ['run-a'] } },
        { actions: ['interactions:read'], scope: { workspaceIds: ['workspace-b'], workflowIds: ['workflow-b'], runIds: ['run-b'] } },
      ],
    }
    const interaction = { ...NATIVE_INTERACTION_FIXTURES.codex, workspaceId: 'workspace-b', workflowId: 'workflow-b', runId: 'run-b', requestingAgentId: 'coder', approval: { handler: 'orchestrator' as const, designatedOrchestratorAgentId: 'reviewer' } }
    assert.equal(canReadInteraction(principal, interaction), true)
    assert.equal(canRespondToInteraction(principal, interaction), false)
    assert.equal(canReadInteraction(principal, { ...interaction, workspaceId: 'workspace-a' }), false)
  })
})

describe.skipIf(process.platform === 'win32')('Codex inspection failure classification', () => {
  it('reports absence only when the named lookup proves it, without falling back to an empty catalog', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'graphql-pr11-codex-'))
    const binary = join(directory, 'codex-fixture.cjs')
    try {
      for (const [exitCode, stdout, stderr, expected] of [
        [1, '', null, 'CODEX_MCP_NOT_CONFIGURED'],
        [1, '', 'configuration unavailable', 'CODEX_MCP_INSPECTION_FAILED'],
        [1, '[]', null, 'CODEX_MCP_INSPECTION_FAILED'],
        [1, '', "Error: No MCP server named 'another-server' found.", 'CODEX_MCP_INSPECTION_FAILED'],
        [0, '{bad json', '', 'CODEX_MCP_CONFIG_INVALID'],
        [0, '[{"name":"foreman-code"}]', '', 'CODEX_MCP_CONFIG_INVALID'],
      ] as const) {
        await writeFile(binary, `#!${process.execPath}
const name = process.argv[4];
const missing = "Error: No MCP server named '" + name + "' found.";
if (process.argv[3] === 'list') { console.log('[]'); process.exit(0); }
if (process.argv[3] !== 'get' || name !== 'foreman-code') { console.error(missing); process.exit(1); }
process.stdout.write(${JSON.stringify(stdout)});
process.stderr.write(${JSON.stringify(stderr)} ?? missing);
process.exit(${exitCode});
`, { mode: 0o755 })
        await chmod(binary, 0o755)
        const forbidden = () => { throw new Error('Configuration inspection cannot start a native session or model turn.') }
        // Qualification is recorded; named CLI lookups run through the real subprocess boundary.
        const dependencies: Extract<CodexSessionDependencies, { mode: 'replay' }> = {
          mode: 'replay', environment: () => ({ ...process.env }), runCommand,
          qualify: async () => ({ binary, identity: 'recorded', protocol: fixtureProtocol,
            providerVersion: RECORDED_CODEX_VERSION, schemaManifestSha256: 'recorded',
            stableSchemaGitBlob: 'recorded', referenceSchemaManifestSha256: 'recorded' }),
          assertUnchanged: forbidden, qualifyModel: forbidden, transport: forbidden, withDiagnostics: forbidden,
          id: () => 'recorded', now: () => new Date(), schedule: setTimeout, cancelTimer: clearTimeout,
        }
        const manager = new CodexAppServerSessionManager(binary, undefined, undefined,
          undefined, undefined, undefined, dependencies)
        try {
          await assert.rejects(manager.inspectMcpConfiguration(directory), (error: unknown) => {
            assert(error instanceof HarnessExecutionError)
            assert.equal(error.result.error?.code, expected)
            return true
          })
        } finally { await manager.dispose() }
      }
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
