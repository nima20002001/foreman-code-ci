import { afterEach, expect, it, vi } from 'vitest'
import { BrowserOperationResponseSchemas } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { endpointFixture, browserSubjects } from '../browser-runtime/endpoints.test-support.js'
import { createBrowserCanonicalCodecs } from './browserCodecs.js'

const fixtures: Awaited<ReturnType<typeof endpointFixture>>[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); vi.restoreAllMocks() })

it.each(browserSubjects())('uses canonical browser codecs for the $kind subject over authenticated MCP and HTTP', async subject => {
  const fixture = await endpointFixture({ codecs: createBrowserCanonicalCodecs() }); fixtures.push(fixture)
  const client = await fixture.connect(), request = fixture.bindSubject(subject)
  const opened = await client.callTool({ name: 'browser_session_open', arguments: { intent: 'prepare', request } })
  expect(opened.isError, JSON.stringify(opened)).not.toBe(true)
  const prepared = BrowserOperationResponseSchemas.browser_session_open.parse(decodeMcpToolResult(opened))
  if (!('kind' in prepared) || prepared.kind !== 'ready') throw new Error('The fixture browser did not prepare')
  const read = await client.callTool({ name: 'browser_session_get', arguments: { sessionId: prepared.session.id } })
  expect(read.isError, JSON.stringify(read)).not.toBe(true)
  const details = BrowserOperationResponseSchemas.browser_session_get.parse(decodeMcpToolResult(read))
  expect(details.session.subject).toEqual(subject)
  const token = `agent-${subject.kind}`
  fixture.addCaller(token, { subject })
  const agent = await fixture.connect(token)
  const tab = details.tabs[0]!, actor = { kind: 'agent', epoch: details.control.epoch, browserGeneration: details.session.browserGeneration }
  const observed = await agent.callTool({ name: 'browser_state_read', arguments: { sessionId: details.session.id, tabId: tab.tabId, actor } })
  expect(observed.isError, JSON.stringify(observed)).not.toBe(true)
  expect(BrowserOperationResponseSchemas.browser_state_read.parse(decodeMcpToolResult(observed))).toHaveProperty('url')
  const screenshot = await agent.callTool({ name: 'browser_screenshot', arguments: { sessionId: details.session.id, tabId: tab.tabId, actor } })
  expect(screenshot.isError, JSON.stringify(screenshot)).not.toBe(true)
  expect(BrowserOperationResponseSchemas.browser_screenshot.parse(decodeMcpToolResult(screenshot))).toMatchObject({ sessionId: details.session.id, tabId: tab.tabId })
  const http = await fixture.app.inject({ method: 'GET', url: `/api/browser/sessions/${details.session.id}`, headers: { authorization: 'Bearer owner' } })
  expect(http.statusCode, http.body).toBe(200)
  expect(http.json()).toEqual(details)
  fixture.addCaller('foreign', { subject: { ...subject, agent: { ...subject.agent, agentId: 'other' } } })
  const foreign = await fixture.connect('foreign')
  expect((await foreign.callTool({ name: 'browser_session_get', arguments: { sessionId: details.session.id } })).isError).toBe(true)
})
