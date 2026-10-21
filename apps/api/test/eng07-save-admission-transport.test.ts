import { describe, expect, it, vi } from 'vitest'
import { rpc, type SaveFixture } from './helpers/eng07SaveAdmission.testSupport.js'

/** The PG fixture already listens and connects its authenticated client before
 * returning. This tripwire catches a regression to graphRpc's lazy listen path
 * without needing PostgreSQL or substituting any admission/settlement service. */
function fixture() {
  const listen = vi.fn(() => { throw new Error('Fastify is already listening') })
  const callTool = vi.fn()
  const client = { callTool }
  const f = { client, app: { listen }, writer: { token: 'unit-only-not-a-credential' } } as unknown as SaveFixture
  return { f, client, callTool, listen }
}

describe('ENG07 Save admission MCP fixture transport', () => {
  it('reuses the connected client for successive calls, with the exact tool arguments', async () => {
    const t = fixture(), input = { workspaceId: 'workspace', commandId: 'same-command' }
    const first = { content: [], structuredContent: { value: { revision: 2 }, replayed: false } }
    const replay = { content: [], structuredContent: { value: { revision: 2 }, replayed: true } }
    t.callTool.mockResolvedValueOnce(first).mockResolvedValueOnce(replay)
    expect(await rpc(t.f, 'workflow_save_v3', input)).toEqual({ result: first })
    expect(await rpc(t.f, 'workflow_save_v3', input)).toEqual({ result: replay })
    expect(t.callTool).toHaveBeenCalledTimes(2)
    for (const [args] of t.callTool.mock.calls) expect(args).toEqual({ name: 'workflow_save_v3', arguments: input })
    expect(t.callTool.mock.calls[0]![0].arguments).toBe(input)
    expect(t.callTool.mock.contexts).toEqual([t.client, t.client])
    expect(t.listen).not.toHaveBeenCalled()
  })

  it('preserves isError and the original negative admission payload', async () => {
    const t = fixture()
    const rejected = { isError: true, content: [{ type: 'text',
      text: JSON.stringify({ error: { code: 'WORKFLOW_RUNS_UNSETTLED', message: 'Unsettled native evidence' } }) }] }
    t.callTool.mockResolvedValueOnce(rejected)
    const result = await rpc(t.f, 'workflow_save_v3', { commandId: 'rejected-command' })
    expect(result.result).toBe(rejected)
    expect(result.result.isError).toBe(true)
    expect(t.callTool).toHaveBeenCalledTimes(1)
    expect(t.listen).not.toHaveBeenCalled()
  })

  it('propagates transport failure without reconnecting, listening or silently retrying', async () => {
    const t = fixture(), error = new Error('MCP connection lost')
    t.callTool.mockRejectedValueOnce(error)
    await expect(rpc(t.f, 'workflow_edit_v3', { action: 'stop_and_save', commandId: 'retained-command' })).rejects.toBe(error)
    expect(t.callTool).toHaveBeenCalledTimes(1)
    expect(t.listen).not.toHaveBeenCalled()
  })
})
