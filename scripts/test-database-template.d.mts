import type { TestDatabase, TestRoot } from './test-resources.mjs'

interface Sql {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}
export interface TestDatabaseTemplate extends TestDatabase {
  hash: string
  persistent?: boolean
  timings: { importMs: number; migrationMs: number; setupMs: number }
}
export function migrationContentsHash(migrations: readonly { version: number; sql: string }[]): string
export function assertTestDatabaseTemplate(admin: Sql, template: TestDatabaseTemplate): Promise<void>
export function createTestDatabaseTemplate(admin: Sql, resource: TestRoot,
  options?: { cacheDirectory?: string | undefined }): Promise<TestDatabaseTemplate>
export function dropTestDatabaseTemplate(admin: Sql, template: TestDatabaseTemplate): Promise<void>
