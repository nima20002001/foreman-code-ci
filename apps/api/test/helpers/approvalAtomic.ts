import { afterEach } from 'vitest'
import { approvalDatabase } from './wave25ApprovalDatabase.js'

type Fixture = Awaited<ReturnType<typeof approvalDatabase>>

export function approvalAtomicSetup() {
  const closes: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (closes.length) await closes.pop()!()
  })
  return async function setup() {
    const fixture = await approvalDatabase()
    closes.push(fixture.close)
    return fixture
  }
}

export function decision(
  fixture: Fixture,
  optionId = fixture.interaction.responseOptions.find((option) => option.semantic === 'approve_once')!.optionId,
) {
  return fixture.repository.decide({
    id: fixture.interaction.id,
    optionId,
    expectedRevision: fixture.interaction.revision,
    principal: fixture.principal,
    nativeResponse: {
      optionId,
      semantic: fixture.interaction.responseOptions.find((option) => option.optionId === optionId)!.semantic,
    },
  })
}
