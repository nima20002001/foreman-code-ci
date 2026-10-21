import { expect, it } from 'vitest'
import { assertMigrationVersions, migrations } from './migrations.js'

it('rejects duplicate migration versions before applying either migration', () => {
  expect(() => assertMigrationVersions([{ version: 7 }, { version: 7 }]))
    .toThrow('Duplicate application migration version: 7')
})

it('preserves registered migration versions and accepts distinct versions in registration order', () => {
  expect(() => assertMigrationVersions([{ version: 8 }, { version: 3 }])).not.toThrow()
  expect(() => assertMigrationVersions(migrations)).not.toThrow()
})
