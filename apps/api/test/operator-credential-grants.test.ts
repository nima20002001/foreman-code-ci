import { describe, expect, it } from 'vitest'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { credentialActions } from '../src/cli/credentialAccess.js'
import { parseCredentialArguments } from '../src/cli/operatorCredentialArguments.js'

describe('explicit operator credential grants', () => {
  it.each(ManagementActionSchema.options)('accepts and includes the supported action %s', action => {
    const input = parseCredentialArguments([
      'issue', '--name', 'Operator', '--access', 'read-only', '--grant', action,
    ])
    expect(input).toMatchObject({ command: 'issue', audience: 'operator', grant: action })
    if (input.command !== 'issue') throw new Error('Expected credential issue arguments')
    const actions = credentialActions(input.access, input.grant)
    expect(actions).toContain(action)
    expect(actions.filter(value => value === action)).toHaveLength(1)
  })

  it('rejects removed provisioning actions and grants for worker credentials', () => {
    expect(() => parseCredentialArguments([
      'issue', '--name', 'Operator', '--grant', 'devices:provision',
    ])).toThrow()
    expect(() => parseCredentialArguments([
      'issue', '--name', 'Worker', '--audience', 'worker', '--grant', 'ci',
    ])).toThrow()
    expect(() => parseCredentialArguments([
      'issue', '--name', 'Worker', '--audience', 'worker', '--grant', 'devices:metrics:read',
    ])).toThrow()
  })
})
