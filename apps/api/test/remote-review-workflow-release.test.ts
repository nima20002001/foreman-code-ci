import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

interface ProviderMessage {
  id?: number
  method?: string
  result?: { thread: { id: string; turns: Array<{ status: string }> } }
}

it.each(['', JSON.stringify({ allowFirst: 1 })])(
  'completes the workflow turn when its release file disappears during a read (%j)', async contents => {
    const storage = join(homedir(), '.cache', 'foreman-tmp')
    await mkdir(storage, { recursive: true })
    const directory = await mkdtemp(join(storage, 'workflow-release-'))
    const block = join(directory, 'block-workflow-turns')
    const preload = join(directory, 'release-during-read.mjs')
    await writeFile(join(directory, 'codex'), 'provider executable fixture')
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ launcher: 'unused' }))
    await writeFile(block, contents)
    // Force the other process's unlink between the existence check and the open.
    await writeFile(preload, `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { join } from 'node:path';
      const block = join(process.argv[2], 'block-workflow-turns');
      const read = fs.readFileSync;
      fs.readFileSync = function (path, ...options) {
        if (path === block) fs.rmSync(block, { force: true });
        return read.call(this, path, ...options);
      };
      syncBuiltinESMExports();
    `)
    const provider = spawn(process.execPath, ['--import', preload,
      fileURLToPath(new URL('./fixtures/remote-review-codex.mjs', import.meta.url)), directory, 'app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CODEX_HOME: directory },
    })
    const exited = new Promise<void>(resolve => { provider.once('exit', () => resolve()) })
    const messages: ProviderMessage[] = []
    const pending = new Map<number, (message: ProviderMessage) => void>()
    const lines = createInterface({ input: provider.stdout })
    lines.on('line', line => {
      const message = JSON.parse(line) as ProviderMessage
      messages.push(message)
      if (message.id !== undefined) {
        pending.get(message.id)?.(message)
        pending.delete(message.id)
      }
    })
    const request = (id: number, method: string, params: unknown) => new Promise<ProviderMessage>(resolve => {
      pending.set(id, resolve)
      provider.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
    try {
      const started = await request(1, 'thread/start', {
        cwd: directory, developerInstructions: 'fixture-reviewer fixture-work-handoff',
      })
      const threadId = started.result!.thread.id
      await request(2, 'turn/start', { threadId, clientUserMessageId: 'execution:workflow',
        input: [{ type: 'text', text: 'Finish the workflow.' }] })
      const history = await request(3, 'thread/read', { threadId, includeTurns: true })
      const calls = await readFile(join(directory, 'calls.jsonl'), 'utf8')
      expect(history.result!.thread.turns.map(turn => turn.status), calls).toEqual(['completed'])
      expect(messages.filter(message => message.method === 'turn/completed')).toHaveLength(1)
      expect(calls.split('\n').filter(Boolean).map(line => JSON.parse(line)))
        .not.toContainEqual(expect.objectContaining({ providerFailure: expect.any(String) }))
    } finally {
      lines.close()
      provider.stdin.end()
      if (provider.exitCode === null && provider.signalCode === null) provider.kill('SIGTERM')
      await exited
      await rm(directory, { recursive: true, force: true })
    }
  },
)
