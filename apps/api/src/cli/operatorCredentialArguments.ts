import { ManagementActionSchema, type ManagementAction } from '@foreman-code/contracts/management'

export type CredentialArguments =
  | { command: 'revoke'; principalId: string }
  | { command: 'issue'; name: string; audience: 'operator' | 'worker'; days: number | null; workspaceId?: string; access?: 'manage' | 'read-only'
      grant?: ManagementAction }

const USAGE = 'Usage: pnpm credential issue --name <name> [--days <days>] [--workspace <id>] [--audience operator|worker] [--access manage|read-only] [--grant <action>], or pnpm credential revoke <principal-id>'
const FLAGS = new Set(['--name', '--days', '--workspace', '--audience', '--access', '--grant'])

/** Parse everything before opening a database or issuing any credential. */
export function parseCredentialArguments(argv: readonly string[]): CredentialArguments {
  const [command, ...args] = argv
  if (command === 'revoke') {
    const principalId = args[0]
    if (args.length !== 1 || !principalId?.trim() || principalId.startsWith('-')) throw new Error(USAGE)
    return { command, principalId }
  }
  if (command !== 'issue') throw new Error(USAGE)
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!
    if (!FLAGS.has(flag)) throw new Error(`Unknown credential argument: ${flag}`)
    if (values.has(flag)) throw new Error(`Duplicate credential argument: ${flag}`)
    const value = args[index + 1]
    if (value === undefined || !value.trim() || value.startsWith('-')) {
      throw new Error(`${flag} requires a value`)
    }
    values.set(flag, value)
  }
  const name = values.get('--name')
  if (!name) throw new Error('--name is required')
  const audience = values.get('--audience') ?? 'operator'
  if (audience !== 'operator' && audience !== 'worker') {
    throw new Error('--audience must be exactly operator or worker')
  }
  const rawDays = values.get('--days') ?? (audience === 'operator' ? undefined : '30')
  const days = rawDays === undefined ? null : Number(rawDays)
  if (days !== null && (!/^\d+$/.test(rawDays ?? '') || !Number.isInteger(days) || days < 1 || days > 365)) {
    throw new Error('--days must be an integer from 1 through 365')
  }
  const workspaceId = values.get('--workspace')
  const access = values.get('--access')
  if (access !== undefined && (audience !== 'operator' || !['manage', 'read-only'].includes(access))) {
    throw new Error('--access must be manage or read-only and is only valid for Operator credentials')
  }
  const rawGrant = values.get('--grant')
  if (rawGrant !== undefined && audience !== 'operator') {
    throw new Error('--grant is only valid for Operator credentials')
  }
  const grant = rawGrant === undefined ? undefined : ManagementActionSchema.parse(rawGrant)
  return { command, name, audience, days, ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(access ? { access: access as 'manage' | 'read-only' } : {}), ...(grant ? { grant } : {}) }

}
