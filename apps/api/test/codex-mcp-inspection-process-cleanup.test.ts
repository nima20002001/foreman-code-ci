import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { CodexAppServerSessionManager, type CodexSessionDependencies } from '../src/modules/harnesses/codexAppServer.js'
import { McpDetectionService } from '../src/modules/harnesses/mcpDetection.js'
import { codexMcpInspectorAdapter } from '../src/modules/harnesses/codexMcpInspectorAdapter.js'
import { runCommand } from '../src/modules/harnesses/process.js'
import { RECORDED_CODEX_VERSION } from './fixtures/codex-version.js'
import { fixtureProtocol } from './fixtures/codex-test-helpers.js'

const phases = ['version', 'authentication', 'schema', 'foreman-code', 'graphql']

it.each(phases)('settles the native process tree when inspection is canceled during %s', async selected => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-inspection-process-'))
  const binary = join(directory, 'codex.cjs')
  const journal = join(directory, 'processes.jsonl')
  const script = `#!${process.execPath}
const { appendFileSync } = require('node:fs')
const { spawn } = require('node:child_process')
const args = process.argv.slice(2)
const phase = args[0] === 'qualification' ? args[1] : args[2]
const selected = process.env.MCP_INSPECTION_BLOCK_PHASE
const journal = process.env.MCP_INSPECTION_PROCESS_JOURNAL
appendFileSync(journal, JSON.stringify({ phase, pid: process.pid }) + '\\n')
if (phase === selected) {
  process.on('SIGTERM', () => {})
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
    { stdio: 'ignore' })
  appendFileSync(journal, JSON.stringify({ phase, pid: child.pid }) + '\\n')
  setInterval(() => {}, 1000)
} else if (phase === 'graphql') {
  process.stderr.write("Error: No MCP server named 'graphql' found.")
  process.exit(1)
} else {
  process.stdout.write(JSON.stringify({ name: phase, enabled: true, transport: { type: 'streamable_http',
    url: 'http://127.0.0.1:3040/mcp', bearer_token_env_var: 'FOREMAN_CODE_MCP_TOKEN' } }))
}
`
  await writeFile(binary, script)
  await chmod(binary, 0o700)
  await writeFile(journal, '')
  const environment = { ...process.env, MCP_INSPECTION_BLOCK_PHASE: selected,
    MCP_INSPECTION_PROCESS_JOURNAL: journal }
  const commands = new Set<Promise<unknown>>()
  const command: typeof runCommand = (...args) => {
    const pending = runCommand(...args)
    commands.add(pending)
    const settled = () => commands.delete(pending)
    void pending.then(settled, settled)
    return pending
  }
  const forbidden = () => { throw new Error('Inspection cannot run a model or start a session') }
  const dependencies: Extract<CodexSessionDependencies, { mode: 'replay' }> = {
    mode: 'replay', environment: () => environment,
    qualify: async (_binary, cwd, env, _authenticate, signal) => {
      for (const phase of phases.slice(0, 3)) {
        await command(binary, ['qualification', phase], cwd, signal, env)
      }
      return { binary, identity: 'recorded', protocol: fixtureProtocol, providerVersion: RECORDED_CODEX_VERSION,
        schemaManifestSha256: 'recorded', stableSchemaGitBlob: 'recorded', referenceSchemaManifestSha256: 'recorded' }
    },
    runCommand: command, assertUnchanged: forbidden, qualifyModel: forbidden, transport: forbidden, withDiagnostics: forbidden,
    id: () => 'recorded', now: () => new Date(), schedule: setTimeout, cancelTimer: clearTimeout,
  }
  const manager = new CodexAppServerSessionManager(binary, undefined, 'foreman-code',
    undefined, undefined, undefined, dependencies)
  const detection = new McpDetectionService(codexMcpInspectorAdapter(manager), 'http://127.0.0.1:3040/mcp')
  const controller = new AbortController()
  const processes = async (): Promise<{ phase: string; pid: number }[]> => (await readFile(journal, 'utf8'))
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { phase: string; pid: number })
  try {
    const pending = detection.inspect({ harness: 'codex', runnerId: 'runner-local', workingDirectory: directory,
      signal: controller.signal })
    await vi.waitFor(async () => {
      expect((await processes()).filter(child => child.phase === selected)).toHaveLength(2)
    }, { timeout: 5_000 })
    controller.abort(new Error('Caller canceled inspection'))
    expect((await pending).nativeFilters.diagnostics).toContain('NATIVE_MCP_INSPECTION_CANCELED')
    await vi.waitFor(async () => {
      for (const child of await processes()) {
        expect(() => process.kill(child.pid, 0)).toThrowError(/ESRCH/)
      }
    }, { timeout: 5_000 })
    expect([...new Set((await processes()).map(child => child.phase))])
      .toEqual(phases.slice(0, phases.indexOf(selected) + 1))
  } finally {
    controller.abort()
    await manager.dispose()
    await Promise.allSettled([...commands])
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
