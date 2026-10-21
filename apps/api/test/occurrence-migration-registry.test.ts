import { describe, expect, it } from 'vitest'
import { migrations } from '../src/infrastructure/migrations.js'
import { repeatOccurrenceMigration } from '../src/infrastructure/repeatOccurrenceMigration.js'

describe('occurrence migration registration', () => {
  it('registers one collision-free occurrence migration', () => {
    expect(repeatOccurrenceMigration.version).toBe(264501)
    const index = migrations.findIndex((migration) => migration.version === repeatOccurrenceMigration.version)
    expect(index).toBeGreaterThan(-1)
    expect(migrations[index]).toBe(repeatOccurrenceMigration)
    expect(migrations.filter((migration) => migration.version === 264501)).toHaveLength(1)
    expect(new Set(migrations.map((migration) => migration.version)).size).toBe(migrations.length)
  })

  it('keeps the occurrence migration before every later writer and native lifecycle migration', () => {
    const versions = migrations.map((migration) => migration.version)
    const occurrence = versions.indexOf(repeatOccurrenceMigration.version)
    expect(versions.indexOf(264502)).toBe(occurrence + 1)
    // Later unrelated migrations may carry lower numbers (264402-264405 were appended after it and are
    // already applied, so they cannot be renumbered). No later writer may be placed before it.
    expect(versions.slice(0, occurrence).every((version) => version < repeatOccurrenceMigration.version)).toBe(true)
  })

})
