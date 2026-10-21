import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'

it('finishes the native review after its decision is recorded while delivery is still pending', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'review-provider-'))
  await writeFile(join(directory, 'codex'), 'review provider executable fixture', { mode: 0o700 })
  const token = 'unit-fixture-token'
  const client = join(directory, 'client.mjs')
  await writeFile(client, `
    export class StreamableHTTPClientTransport {}
    export class Client {
      async connect() {}
      async close() {}
      async callTool({ name }) {
        const interaction = { id: 'interaction-original', revision: 1,
          responseOptions: [{ optionId: 'approve-original', semantic: 'approve_once' }] };
        if (name === 'interaction_get') return { structuredContent: { interaction } };
        return { structuredContent: { interaction: { ...interaction, status: 'delivery_pending',
          deliveryState: 'pending', selectedOptionId: 'approve-original', selectedSemantic: 'approve_once' } } };
      }
    }
  `)
  await mkdir(join(directory, 'routes'))
  await writeFile(join(directory, 'routes', `${createHash('sha256').update(token).digest('hex')}.json`),
    JSON.stringify({ endpoint: 'http://127.0.0.1:1/mcp' }))
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ clientModule: client,
    launcher: join(directory, 'launcher.mjs') }))
  await writeFile(join(directory, 'release-review'), '')
  const provider = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/remote-review-codex.mjs', import.meta.url)),
    directory, 'app-server'], { stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FOREMAN_CODE_MCP_TOKEN: token } })
  const messages: Array<{ id?: number; method?: string; result?: { thread: { id: string } } }> = []
  const lines = createInterface({ input: provider.stdout })
  lines.on('line', line => { messages.push(JSON.parse(line)) })
  let stderr = ''
  provider.stderr.on('data', chunk => { stderr += String(chunk) })
  const send = (value: unknown) => provider.stdin.write(`${JSON.stringify(value)}\n`)
  try {
    send({ id: 1, method: 'thread/start', params: { cwd: directory } })
    await vi.waitFor(() => expect(messages.find(message => message.id === 1)?.result?.thread.id).toBeDefined())
    const threadId = messages.find(message => message.id === 1)!.result!.thread.id
    send({ id: 2, method: 'turn/start', params: { threadId, clientUserMessageId: 'review-original',
      input: [{ type: 'text', text: 'Review pending interaction interaction-original.' }] } })
    await vi.waitFor(() => expect(messages.some(message => message.method === 'turn/completed'), stderr).toBe(true))
    expect(messages.filter(message => message.method === 'turn/completed')).toHaveLength(1)
  } finally {
    lines.close()
    if (provider.exitCode === null && provider.signalCode === null) {
      await new Promise<void>(resolve => { provider.once('exit', () => resolve()); provider.kill('SIGTERM') })
    }
    await rm(directory, { recursive: true, force: true })
  }
})
