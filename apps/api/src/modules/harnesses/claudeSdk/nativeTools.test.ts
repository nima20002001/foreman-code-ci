import { expect, it } from 'vitest'
import type { NativeSessionStart } from '../port.js'
import { fixture, start } from './__tests__/sessionManager.js'

it('filters Claude SDK servers and plugins from the pinned Agent policy', async () => {
  const servers = { 'foreman-code': { type: 'http', url: 'http://local/mcp' },
    'graphql-files': { type: 'sdk' }, linear: { type: 'http', url: 'http://local/linear' },
    slack: { type: 'http', url: 'http://local/slack' } }
  const pinned = { ...start, configuration: { nativeTools: { mcpServers: ['linear'], apps: false } } } as NativeSessionStart
  const f = fixture(undefined, { inspectionStart: () => pinned,
    sdkOptions: { mcpServers: servers, plugins: [{ type: 'local', path: '/plugin' }] } })
  try {
    await f.manager.inspectMcp!()
    expect(f.queries.mock.calls[0]![0].options).toMatchObject({ plugins: [], mcpServers: {
      'foreman-code': servers['foreman-code'], 'graphql-files': servers['graphql-files'], linear: servers.linear,
    } })
    expect(f.queries.mock.calls[0]![0].options.mcpServers).not.toHaveProperty('slack')
    expect(servers).toHaveProperty('slack')
  } finally {
    await f.manager.dispose!()
  }
})

it('keeps Claude SDK servers and plugins when no policy is saved', async () => {
  const sdkOptions = { mcpServers: { linear: { type: 'http', url: 'http://local/linear' } },
    plugins: [{ type: 'local', path: '/plugin' }] }
  const f = fixture(undefined, { inspectionStart: () => start, sdkOptions })
  try {
    await f.manager.inspectMcp!()
    expect(f.queries.mock.calls[0]![0].options).toMatchObject(sdkOptions)
  } finally {
    await f.manager.dispose!()
  }
})
