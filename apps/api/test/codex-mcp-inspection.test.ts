import { expect, it, vi } from 'vitest'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexAppServerSessionManager, type CodexSessionDependencies } from '../src/modules/harnesses/codexAppServer.js'
import { McpDetectionService } from '../src/modules/harnesses/mcpDetection.js'
import { codexMcpInspectorAdapter } from '../src/modules/harnesses/codexMcpInspectorAdapter.js'
import { runCommand } from '../src/modules/harnesses/process.js'
import { RECORDED_CODEX_VERSION } from './fixtures/codex-version.js'
import { fixtureProtocol, until } from './fixtures/codex-test-helpers.js'

function fixture(entries: Record<string, { enabled: boolean }>,
  options: {
    commandFailure?: string
    requestedName?: string
    command?: typeof runCommand
    qualificationDelayMs?: number
  } = {}) {
  const commands: string[][] = []
  const forbidden = () => { throw new Error('Inspection cannot start native sessions or model work.') }
  const dependencies: Extract<CodexSessionDependencies, { mode: 'replay' }> = {
    mode: 'replay', environment: () => ({}),
    qualify: async (binary) => {
      if (options.qualificationDelayMs) {
        await new Promise(resolve => setTimeout(resolve, options.qualificationDelayMs))
      }
      return {
        binary, identity: 'recorded-launcher', protocol: fixtureProtocol,
        providerVersion: RECORDED_CODEX_VERSION, schemaManifestSha256: 'recorded', stableSchemaGitBlob: 'recorded',
        referenceSchemaManifestSha256: 'recorded',
      }
    },
    assertUnchanged: forbidden, qualifyModel: forbidden, transport: forbidden,
    withDiagnostics: forbidden, id: () => 'recorded', now: () => new Date(), schedule: setTimeout, cancelTimer: clearTimeout,
    runCommand: options.command ?? (async (_binary, args) => {
      commands.push(args)
      const name = args[2]!
      if (options.commandFailure) return { exitCode: 1, stdout: '', stderr: options.commandFailure }
      const entry = entries[name]
      if (!entry) return { exitCode: 1, stdout: '', stderr: `Error: No MCP server named '${name}' found.` }
      return { exitCode: 0, stderr: '', stdout: JSON.stringify({ name, enabled: entry.enabled,
        transport: { type: 'streamable_http', url: 'http://127.0.0.1:3040/mcp',
          bearer_token_env_var: 'FOREMAN_CODE_MCP_TOKEN' }, disabled_tools: ['files.publish_result'] }) }
    }),
  }
  return { manager: new CodexAppServerSessionManager('/recorded-codex', undefined, options.requestedName,
    undefined, undefined, undefined, dependencies), commands }
}

it.each(['foreman-code', 'graphql'])('reads %s configuration without a global catalog listing', async (name) => {
  const f = fixture({ [name]: { enabled: true } })
  const result = await f.manager.inspectMcpConfiguration('/accepted-project')
  expect(result).toMatchObject({ cwd: '/accepted-project', serverName: name,
    configured: { enabled: true, bearerTokenEnvironmentVariable: 'FOREMAN_CODE_MCP_TOKEN',
      disabledTools: ['files.publish_result'] } })
  expect(f.commands).toEqual([['mcp', 'get', 'foreman-code', '--json'], ['mcp', 'get', 'graphql', '--json']])
})

it('keeps both enabled and disabled names in collision detection', async () => {
  const f = fixture({ 'foreman-code': { enabled: true }, graphql: { enabled: false } })
  expect((await f.manager.inspectMcp()).state).toBe('check_failed')
})

it('distinguishes a definite missing entry from an inspection failure', async () => {
  expect((await fixture({}).manager.inspectMcp()).state).toBe('not_detected')
  expect((await fixture({}, { commandFailure: 'Configuration could not be read.' }).manager.inspectMcp()).state).toBe('check_failed')
})

it('inspects an explicitly requested custom name without changing its binding', async () => {
  const f = fixture({ docs: { enabled: true } }, { requestedName: 'docs' })
  expect((await f.manager.inspectMcp()).serverName).toBe('docs')
  expect(f.commands).toEqual([['mcp', 'get', 'docs', '--json']])
})

it('allows cold configuration commands after slow qualification', async () => {
  vi.useFakeTimers()
  try {
    const f = fixture({}, { requestedName: 'foreman-code', qualificationDelayMs: 28_000,
      command: async (_binary, args) => {
        await new Promise(resolve => setTimeout(resolve, 5_000))
        if (args[2] === 'graphql') {
          return { exitCode: 1, stdout: '', stderr: "Error: No MCP server named 'graphql' found." }
        }
        return { exitCode: 0, stderr: '', stdout: JSON.stringify({ name: 'foreman-code', enabled: true,
          transport: { type: 'streamable_http', url: 'http://127.0.0.1:3040/mcp',
            bearer_token_env_var: 'FOREMAN_CODE_MCP_TOKEN' } }) }
      } })
    const detection = new McpDetectionService(codexMcpInspectorAdapter(f.manager), 'http://127.0.0.1:3040/mcp')
    const pending = detection.preflight({ harness: 'codex', runnerId: 'runner-local', workingDirectory: '/workspace' })
    const assertion = expect(pending).resolves.toMatchObject({ detection: { state: 'status_unavailable' } })
    await vi.advanceTimersByTimeAsync(38_000)
    await assertion
  } finally {
    vi.useRealTimers()
  }
})

it('reports command timeouts through configuration preflight and passive inspection', async () => {
  const f = fixture({}, { command: async () => {
    throw new DOMException('private provider output', 'TimeoutError')
  } })
  const detection = new McpDetectionService(codexMcpInspectorAdapter(f.manager), 'http://127.0.0.1:3040/mcp')
  await expect(detection.preflight({ harness: 'codex', runnerId: 'runner-local', workingDirectory: '/workspace' }))
    .rejects.toMatchObject({ code: 'APP_MCP_PREFLIGHT_TIMEOUT' })
  const result = await f.manager.inspectMcp()
  expect(result.state).toBe('check_failed')
  expect(result.detail).toContain('timed out')
  expect(result.detail).not.toContain('private provider output')
})

it('reads a slow fake CLI and still cancels an in-flight command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-mcp-inspection-'))
  const binary = join(directory, 'codex.cjs')
  await writeFile(binary, `#!${process.execPath}
if (process.argv[4] === 'graphql') {
  process.stderr.write("Error: No MCP server named 'graphql' found.")
  process.exit(1)
}
const fs = require('node:fs')
const ready = require('node:path').join(__dirname, 'command-ready')
const release = require('node:path').join(__dirname, 'command-release')
let released = false
const watcher = fs.watch(__dirname, () => {
  if (released || !fs.existsSync(release)) return
  released = true
  watcher.close()
  process.stdout.write(JSON.stringify({ name: 'foreman-code', enabled: true,
  transport: { type: 'streamable_http', url: 'http://127.0.0.1:3040/mcp',
    bearer_token_env_var: 'FOREMAN_CODE_MCP_TOKEN' } }))
})
fs.writeFileSync(ready, '')
`)
  await chmod(binary, 0o755)
  const f = fixture({}, { requestedName: 'foreman-code',
    command: (_binary, args, _cwd, signal) => runCommand(binary, args, directory, signal) })
  const controller = new AbortController()
  const commands: Promise<unknown>[] = []
  try {
    const ready = join(directory, 'command-ready')
    const release = join(directory, 'command-release')
    const inspection = f.manager.inspectMcpConfiguration(directory, controller.signal)
    commands.push(Promise.allSettled([inspection]))
    await until(async () => existsSync(ready))
    await writeFile(release, '')
    expect((await inspection).configured.enabled).toBe(true)
    await Promise.all([rm(ready), rm(release)])
    const pending = f.manager.inspectMcpConfiguration(directory, controller.signal)
    commands.push(Promise.allSettled([pending]))
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await until(async () => existsSync(ready))
    controller.abort()
    await assertion
  } finally {
    controller.abort()
    await Promise.all(commands)
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)
