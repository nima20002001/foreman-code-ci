import { open } from 'node:fs/promises'
import { z } from 'zod'
import { HarnessHostReferenceSchema } from '@foreman-code/contracts/harness-registry'
import { AcceptedNodePlacementSchema } from '@foreman-code/contracts/node-placement'
import { CiComputersOutputSchema } from '@foreman-code/contracts'

export const CiComputerHostSchema = CiComputersOutputSchema.shape.computers.element.shape.hostRef
  .refine(host => {
    if (host.kind === 'cloud') return host.provider !== undefined && host.slot !== undefined && !host.deviceId
    if (host.provider !== undefined || host.slot !== undefined) return false
    return host.kind === 'device' ? !!host.deviceId : !host.deviceId
  }, 'Supply the complete physical computer or cloud provider/slot identity.')

const ComputerSchema = z.object({
  name: z.string().min(1).max(80),
  hostRef: HarnessHostReferenceSchema,
  registration: AcceptedNodePlacementSchema.shape.registration,
}).strict().refine(value => (value.hostRef.kind === 'device') === (value.registration !== null),
  'Worker registration is required only for device computers.')

export const CrossComputerCiInputSchema = z.object({
  endpoint: z.url().refine(value => {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && url.pathname === '/mcp'
      && !url.username && !url.password && !url.search && !url.hash
  }, 'Use the production Main /mcp endpoint without embedded credentials.'),
  token: z.string().min(1),
  deniedToken: z.string().min(1),
  evidenceDirectory: z.string().startsWith('/').min(2),
  /** Every Agent on Main (CI may still use every CI computer): the local scenario before the multi-computer one. */
  localOnly: z.boolean().default(false),
  workspaces: z.array(z.object({
    workspaceId: z.string().min(1),
    project: z.enum(['graphql', 'demo']),
    computers: z.array(ComputerSchema).min(1).max(3),
    ciComputers: z.array(CiComputerHostSchema).max(64).default([]),
  }).strict()).length(2),
  excludedComputers: z.array(z.object({
    workspaceId: z.string().min(1),
    hostRef: CiComputerHostSchema,
    reason: z.enum(['offline', 'refusing']),
  }).strict()).max(10).default([]),
}).strict().superRefine((value, context) => {
  const fail = (message: string) => context.addIssue({ code: 'custom', message })
  if (value.token === value.deniedToken) fail('The denied caller must have a separate credential.')
  if (new Set(value.workspaces.map(workspace => workspace.workspaceId)).size !== 2
    || new Set(value.workspaces.map(workspace => workspace.project)).size !== 2) {
    fail('Supply distinct graphql and demo workspaces.')
  }
  const graphql = value.workspaces.find(workspace => workspace.project === 'graphql')
  if (!graphql || graphql.computers.length < (value.localOnly ? 1 : 2)
    || graphql.computers.filter(computer => computer.hostRef.kind === 'main').length !== 1) {
    fail(value.localOnly ? 'The local graphql project needs Main.'
      : 'The graphql project needs Main and at least one distinct Worker Agent computer.')
  }
  for (const workspace of value.workspaces) {
    if (new Set(workspace.computers.map(computer => JSON.stringify(computer.hostRef))).size !== workspace.computers.length) {
      fail('Agent computers must be distinct within a workspace.')
    }
  }
  const mainIds = new Set(value.workspaces.flatMap(workspace => workspace.computers.map(computer => computer.hostRef.mainId)))
  const ciHosts = value.workspaces.flatMap(workspace => workspace.ciComputers)
  if (mainIds.size !== 1 || [...ciHosts, ...value.excludedComputers.map(computer => computer.hostRef)]
    .some(host => !mainIds.has(host.mainId))) {
    fail('All computers must belong to the same Main.')
  }
  if (value.excludedComputers.some(computer => !value.workspaces.some(workspace => workspace.workspaceId === computer.workspaceId))) {
    fail('Excluded candidates must belong to a scenario workspace.')
  }
  for (const workspace of value.workspaces) {
    if (new Set(workspace.ciComputers.map(host => JSON.stringify(host))).size !== workspace.ciComputers.length) {
      fail('CI computer identities must be distinct within a workspace.')
    }
    const readyHosts = [...workspace.computers.map(computer => computer.hostRef), ...workspace.ciComputers]
    if (value.excludedComputers.some(excluded => excluded.workspaceId === workspace.workspaceId
      && readyHosts.some(host => JSON.stringify(host) === JSON.stringify(excluded.hostRef)))) {
      fail('An excluded computer cannot also be a required ready computer.')
    }
  }
})
export type CrossComputerCiInput = z.infer<typeof CrossComputerCiInputSchema>
export type ScenarioWorkspace = CrossComputerCiInput['workspaces'][number]
export type ScenarioComputer = ScenarioWorkspace['computers'][number]

export async function readCrossComputerCiInput(): Promise<CrossComputerCiInput> {
  const path = process.env.FOREMAN_CODE_CROSS_COMPUTER_CI_INPUT
  if (!path) throw new Error('Set FOREMAN_CODE_CROSS_COMPUTER_CI_INPUT to a private scenario JSON file.')
  const file = await open(path, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 64 * 1024) {
      throw new Error('The scenario input must be a private regular file (0600) no larger than 64 KiB.')
    }
    let value: unknown
    try {
      value = JSON.parse(await file.readFile('utf8'))
    } catch {
      throw new Error('The private CI input is not valid JSON.')
    }
    const parsed = CrossComputerCiInputSchema.safeParse(value)
    // Zod errors can contain rejected values, including credentials.
    if (!parsed.success) throw new Error('Invalid cross-computer CI input; check the documented fixture shape.')
    return parsed.data
  } finally {
    await file.close()
  }
}
