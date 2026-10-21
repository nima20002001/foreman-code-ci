import { describe, expect, it, vi } from 'vitest'
import { NATIVE_INTERACTION_FIXTURES } from '@foreman-code/contracts'
import { ApiClient } from './client'

function fixture() {
  const interaction = { ...NATIVE_INTERACTION_FIXTURES.codex, approval: { handler: 'user' as const } }
  const fetcher = vi.fn<typeof fetch>(async (_url, options) => new Response(JSON.stringify(
    options?.method === 'POST' ? { interaction, replayed: false } : { interaction, canRespond: true },
  ), { status: 200, headers: { 'content-type': 'application/json' } }))
  return { interaction, fetcher, client: new ApiClient({ baseUrl: 'http://localhost', fetch: fetcher }) }
}

describe('local human approval HTTP boundary', () => {
  it('reads without browser cookies or bearer credentials', async () => {
    const { interaction, client, fetcher } = fixture()
    const result = await client.getUserInteraction(interaction.id)
    expect(result.canRespond).toBe(true)
    const [url, options] = fetcher.mock.calls[0]!
    expect(String(url)).toBe(`http://localhost/api/user/interactions/${encodeURIComponent(interaction.id)}`)
    expect(options?.credentials).toBe('omit')
    expect(new Headers(options?.headers).has('Authorization')).toBe(false)
  })

  it('posts the exact request and choice identities to the User response route', async () => {
    const { interaction, client, fetcher } = fixture()
    const input = { interactionId: interaction.id, optionId: interaction.responseOptions[0]!.optionId, expectedRevision: interaction.revision }
    await client.respondToUserInteraction(input)
    const [url, options] = fetcher.mock.calls[0]!
    expect(String(url)).toBe(`http://localhost/api/user/interactions/${encodeURIComponent(interaction.id)}/respond`)
    expect(options?.method).toBe('POST')
    expect(options?.credentials).toBe('omit')
    expect(JSON.parse(String(options?.body))).toEqual(input)
    expect(String(url)).not.toContain('fixture-human-token')
  })

  it('omits browser cookies even when a caller requests inclusion', async () => {
    const { interaction, client, fetcher } = fixture()
    await client.getUserInteraction(interaction.id, { credentials: 'include' })
    expect(fetcher.mock.calls[0]![1]?.credentials).toBe('omit')
  })

})
