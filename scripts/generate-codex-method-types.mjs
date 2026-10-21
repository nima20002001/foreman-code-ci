import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// Types use the bundled executable as a compile-time reference; runtime contracts are checked separately.
const directory = await mkdtemp(join(tmpdir(), 'graphql-codex-types-'))
const binary = resolve('apps/api/node_modules/.bin/codex')
const methods = {
  initialize: ['InitializeParams', 'InitializeResponse'],
  'thread/start': ['v2/ThreadStartParams', 'v2/ThreadStartResponse'],
  'thread/resume': ['v2/ThreadResumeParams', 'v2/ThreadResumeResponse'],
  'thread/read': ['v2/ThreadReadParams', 'v2/ThreadReadResponse'],
  'thread/turns/list': ['v2/ThreadTurnsListParams', 'v2/ThreadTurnsListResponse'],
  'thread/items/list': ['v2/ThreadItemsListParams', 'v2/ThreadItemsListResponse'],
  'turn/start': ['v2/TurnStartParams', 'v2/TurnStartResponse'],
  'turn/interrupt': ['v2/TurnInterruptParams', 'v2/TurnInterruptResponse'],
  'turn/steer': ['v2/TurnSteerParams', 'v2/TurnSteerResponse'],
  'thread/fork': ['v2/ThreadForkParams', 'v2/ThreadForkResponse'],
  'config/read': ['v2/ConfigReadParams', 'v2/ConfigReadResponse'],
  'model/list': ['v2/ModelListParams', 'v2/ModelListResponse'],
  'config/batchWrite': ['v2/ConfigBatchWriteParams', 'v2/ConfigWriteResponse'],
  'mcpServerStatus/list': ['v2/ListMcpServerStatusParams', 'v2/ListMcpServerStatusResponse'],
  'account/login/start': ['v2/LoginAccountParams', 'v2/LoginAccountResponse'],
  'account/login/cancel': ['v2/CancelLoginAccountParams', 'v2/CancelLoginAccountResponse'],
}
try {
  const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim()
  if (!/^codex-cli \d+\.\d+\.\d+$/.test(version)) throw new Error('Codex returned no recognized version.')
  execFileSync(binary, ['app-server', 'generate-ts', '--out', directory], { stdio: 'pipe' })
  const sources = new Map()
  const visit = async (file) => {
    if (sources.has(file)) return
    const source = await readFile(file, 'utf8')
    sources.set(file, source)
    for (const match of source.matchAll(/from "([^"]+)"/g)) await visit(resolve(dirname(file), match[1] + '.ts'))
  }
  for (const types of Object.values(methods)) for (const type of types) await visit(join(directory, type + '.ts'))
  const body = [...sources.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, source]) => source
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\/\/.*\n/gm, '').replace(/^import .*;\n/gm, '').trim()).join('\n\n')
  const name = (path) => path.split('/').at(-1)
  const map = Object.entries(methods).map(([method, [params, result]]) => `  '${method}': { params: ${name(params)}; result: ${name(result)} }`).join('\n')
  await writeFile('apps/api/src/modules/harnesses/codexMethodTypes.ts', `// Generated from bundled ${version} via scripts/generate-codex-method-types.mjs.\n// Compile-time baseline only; every launch still validates its own emitted schema.\n\n${body}\n\nexport interface CodexMethodMap {\n${map}\n  'config/mcpServer/reload': { params: Record<string, never>; result: Record<string, never> }\n}\n`)
} finally { await rm(directory, { recursive: true, force: true }) }
