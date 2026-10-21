import { describe, it } from 'vitest'
import { assertRevocationRejected } from './rh01-selected-run-admission.helpers.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

const cases = (['http', 'mcp'] as const).flatMap(transport =>
  (['principal', 'parent'] as const).map(revocation => ({ transport, revocation, boundary: 'existing-row' as const })))

describe.skipIf(!postgresEnabled)('selected Run authorization during message admission', () => {
  it.each(cases)(
    '$transport rejects $revocation revocation committed during $boundary contention',
    assertRevocationRejected,
    90000,
  )
})
