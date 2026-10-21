import type { Client } from '@modelcontextprotocol/client'
import { CiGetOutputSchema, CiLogsOutputSchema, CiRunRecordSchema } from '@foreman-code/contracts'
import { expect } from 'vitest'
import { z } from 'zod'
import { callCiTool, type CiToolOptions } from './crossComputerCiSetup.js'

const TerminalStateSchema = CiRunRecordSchema.shape.state.extract(['passed', 'failed', 'canceled', 'lost'])
export const AgentCiReportSchema = z.object({
  suite: CiRunRecordSchema.shape.suite,
  outcome: TerminalStateSchema,
  repository: CiRunRecordSchema.shape.repository,
  logLine: z.string().trim().min(1).max(2000),
  observedStates: z.array(CiRunRecordSchema.shape.state).min(1),
}).strict()
export type AgentCiReport = z.infer<typeof AgentCiReportSchema>
export type CiReadback = z.infer<typeof CiGetOutputSchema>

export function readAgentCiReport(output: unknown): AgentCiReport {
  const envelope = z.object({ text: z.string() }).safeParse(output)
  const raw = envelope.success ? envelope.data.text : output
  const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
  // Workflow Agents return their deliverable inside the routed workflow output.
  const routed = z.object({ data: z.object({ latestDeliverable: z.unknown() }) }).safeParse(value)
  return AgentCiReportSchema.parse(routed.success ? routed.data.data.latestDeliverable : value)
}

/** Whether the Agent execution requested the group: it initiated it, or joined it as an identical request. */
export function ciGroupRequestedBy(group: CiReadback, executionId: string): boolean {
  return group.run.initiator.executionId === executionId
    || Boolean(group.sharing?.requesters.some(requester => !requester.initiator && requester.executionId === executionId))
}

export function ciTerminal(state: string): boolean {
  return TerminalStateSchema.safeParse(state).success
}

export async function readCiLog(client: Pick<Client, 'callTool'>, scope: { workspaceId: string; ticketId: string },
  options: CiToolOptions = {}) {
  let cursor = 0
  let text = ''
  for (let pageNumber = 0; pageNumber < 1024; pageNumber++) {
    const page = CiLogsOutputSchema.parse(await callCiTool(client, 'ci_logs_read', {
      ...scope, afterOffset: cursor, maxBytes: 65_536,
    }, options))
    expect(page.parts).toBeUndefined()
    expect(page.nextOffset).toBeGreaterThanOrEqual(cursor)
    expect(page.nextOffset).toBeLessThanOrEqual(page.logBytes)
    text += page.text
    if (page.nextOffset === page.logBytes) return { text, logBytes: page.logBytes }
    expect(page.nextOffset, 'A nonempty CI log page must advance its byte cursor').toBeGreaterThan(cursor)
    cursor = page.nextOffset
  }
  throw new Error('CI log read exceeded its bounded pagination budget.')
}

export function requireCiStateOrder(states: readonly string[]) {
  for (const [index, state] of states.entries()) {
    expect(CiRunRecordSchema.shape.state.safeParse(state).success, 'CI state must be recognized').toBe(true)
    if (ciTerminal(states[index - 1] ?? '')) expect(state).toBe(states[index - 1])
  }
  expect(ciTerminal(states.at(-1) ?? '')).toBe(true)
}
