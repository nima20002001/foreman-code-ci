import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { protocolFromBundle } from '../src/modules/harnesses/codexProtocol.js'

it('validates native account reads against the installed protocol schema', async () => {
  const bundle = JSON.parse(await readFile(new URL('./fixtures/codex-protocol.schemas.json', import.meta.url), 'utf8'))
  const protocol = protocolFromBundle(bundle, 'codex-cli 0.154.0')
  protocol.request({ id: 'account-reader', method: 'account/read', params: { refreshToken: false } })
  expect(() => protocol.response('account/read', { account: { type: 'chatgpt', email: 'reader@example.test',
    planType: 'plus' }, requiresOpenaiAuth: true })).not.toThrow()
  expect(() => protocol.response('account/read', { account: null, requiresOpenaiAuth: true })).not.toThrow()
  expect(() => protocol.response('account/read', { account: 'signed-in', requiresOpenaiAuth: true })).toThrow()
})
