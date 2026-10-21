import { expect, it, vi } from 'vitest'
import { silentRootChannel } from './helpers/silentRootChannel.js'
import { placementDiscoveryFixture } from './helpers/placementDiscoveryFixture.js'

it.each(['http', 'mcp'] as const)('keeps healthy choices when first-use Worker adoption reaches its deadline through %s',
  async via => {
    let channel: ReturnType<typeof silentRootChannel> | undefined
    let signal: AbortSignal | undefined
    let channelFailure: unknown
    const f = await placementDiscoveryFixture({ deviceCount: 2, missingWorkerPolicy: true,
      configurationRequest: async (payload, options, binding) => {
        signal = options?.signal
        channel = silentRootChannel(binding)
        try { return await channel.request(payload, options) }
        catch (error) { channelFailure = error; throw error }
      },
    })
    try {
      const rootsBefore = await f.roots()
      expect(rootsBefore.items).toHaveLength(2)
      const result = await f.read(via)
      expect(signal?.aborted).toBe(true)
      expect(signal?.reason).toMatchObject({ name: 'TimeoutError' })
      expect(channelFailure).toMatchObject({ code: 'cancelled' })
      expect(result.pending).toBe(true)
      expect(result.choices).toHaveLength(2)
      expect(result.choices.every(choice => choice.availability === 'ready')).toBe(true)
      expect(result.choices).toEqual(expect.arrayContaining([
        expect.objectContaining({ placement: expect.objectContaining({ hostRef: f.native.placement.local.hostRef }) }),
        expect.objectContaining({ placement: expect.objectContaining({ hostRef: f.native.placement.remotes[1]!.hostRef }) }),
      ]))
      expect(await f.roots()).toEqual(rootsBefore)
      await f.expectDenied()
    } finally {
      await channel?.close()
      await f.close()
      vi.restoreAllMocks()
    }
  }, 120_000)

it.each(['http', 'mcp'] as const)('preserves genuine cancellation during first-use Worker adoption through %s', async via => {
  let channel: ReturnType<typeof silentRootChannel> | undefined
  let signal: AbortSignal | undefined
  let channelFailure: unknown
  const f = await placementDiscoveryFixture({ deviceCount: 2, missingWorkerPolicy: true,
    configurationRequest: async (payload, options, binding) => {
      signal = options?.signal
      channel = silentRootChannel(binding)
      const controller = new AbortController()
      const request = channel.request(payload, { ...options, signal: controller.signal })
      await channel.sent.promise
      controller.abort(new DOMException('Caller cancelled the request.', 'AbortError'))
      try { return await request }
      catch (error) { channelFailure = error; throw error }
    },
  })
  try {
    const rootsBefore = await f.roots()
    if (via === 'mcp') {
      const result = await f.owner.callTool({ name: 'workflow_node_placement_choices', arguments: f.input })
      expect(result.isError).toBe(true)
      expect(result).not.toHaveProperty('structuredContent.choices')
    } else {
      const path = `/api/management/workspaces/${f.input.workspaceId}/workflows/${f.input.workflowId}`
        + `/nodes/${f.input.nodeId}/placement-choices?agentConfigurationVersionId=${f.input.agentConfigurationVersionId}`
      const response = await f.app.inject({ method: 'GET', url: path, headers: f.native.headers })
      expect(response.statusCode).toBeGreaterThanOrEqual(400)
      expect(response.json()).not.toHaveProperty('choices')
    }
    expect(signal?.aborted).toBe(false)
    expect(channelFailure).toMatchObject({ code: 'cancelled' })
    expect(await f.roots()).toEqual(rootsBefore)
  } finally {
    await channel?.close()
    await f.close()
    vi.restoreAllMocks()
  }
}, 120_000)
