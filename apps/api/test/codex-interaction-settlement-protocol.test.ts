import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { protocolFromBundle } from '../src/modules/harnesses/codexProtocol.js'
import { harnessBinaries } from '../src/modules/harnesses/binaries.js'
import { translateCodexInteraction, resolveCodexInteractionResponse } from '../src/modules/harnesses/codexInteractions.js'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'

it('validates user answers and form content against the selected native Codex protocol', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-interaction-schema-'))
  const binary = harnessBinaries(process.env).codexBinary
  const execute = promisify(execFile)
  try {
    const version = await execute(binary, ['--version'])
    const providerVersion = version.stdout.trim()
    expect(providerVersion).toMatch(/^codex-cli\s+\S/)
    await execute(binary, ['app-server', 'generate-json-schema', '--experimental', '--out', directory])
    const protocol = protocolFromBundle(JSON.parse(await readFile(
      join(directory, 'codex_app_server_protocol.schemas.json'), 'utf8')), providerVersion)
    const requests = [
      { id: 1, method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn',
        itemId: 'question', isBlocking: true, questions: [{ id: 'generic', header: 'Question', question: 'Answer?',
          isOther: true, isSecret: false, options: null }] } },
      { id: 2, method: 'mcpServer/elicitation/request', params: { threadId: 'thread', turnId: 'turn',
        mode: 'form', serverName: 'app', message: 'Enter email', requestedSchema: { type: 'object',
          properties: { email: { type: 'string' } }, required: ['email'] } } },
    ]
    for (const request of requests) {
      protocol.serverRequest(request)
      const translated = translateCodexInteraction({
        session: { harness: 'codex', nativeSessionId: 'thread', providerVersion },
        configuration: DEFAULT_HARNESS_DEFAULTS.codex, connectionId: 'connection', generation: 1,
      }, request)!
      const option = translated.pending.responseOptions[0]!
      const response = request.method === 'item/tool/requestUserInput'
        ? { generic: { answers: ['Entered answer'] } } : { email: 'user@example.com' }
      protocol.serverResponse(request.method,
        resolveCodexInteractionResponse(translated.responses.get(option.optionId)!, { ...option, response }))
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 30_000)
