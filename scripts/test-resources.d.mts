import type { TestDatabaseTemplate } from './test-database-template.mjs'
export interface TestRoot { directory: string; token: string }
export interface TestDatabase extends TestRoot { name: string; databaseUrl: string; template?: TestDatabaseTemplate }
interface Sql {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}
export const testAdminUrl: string
export function testAdminPool(): Promise<Sql & { end(): Promise<void> }>
export function requireTestServerUrl(value: string): URL
export function createTestRoot(parent?: string, prefix?: string): TestRoot
export function assertTestRoot(directory: string, token: string): void
export function assertTestPath(resource: TestRoot, path: string): string
export function removeTestRoot(resource: TestRoot): void
export function registerTestResourceCleanup(resource: TestRoot, details: Record<string, unknown>): string
export function completeTestResourceCleanup(resource: TestRoot, id: string): void
export function readTestResourceCleanups(resource: TestRoot): Record<string, unknown>[]
export function recoverAbandonedTestRoots(admin: Sql, options?: {
  parent?: string;
  containers?: (args: string[]) => string;
}): Promise<{ removed: string[]; retained: { directory: string; reason: string }[] }>
export function assertTestResourcesSettled(resource: TestRoot): void
export function assertFixtureResourcesSettled(directory: string): void
export function settleTestResources(admin: Sql, resource: TestRoot): Promise<void>
export function cleanupTestResources(resource: TestDatabase): Promise<void>
export function testEnvironment(environment: NodeJS.ProcessEnv, resource: TestDatabase): NodeJS.ProcessEnv
export function copyTestAuthenticationFile(resource: TestRoot, filename: string, destination: string): void
export function referenceTestAuthenticationFile(resource: TestRoot, filename: string, destination: string): void
export function provisionTestResources(environment?: NodeJS.ProcessEnv): Promise<{
  environment: NodeJS.ProcessEnv
  close(): Promise<void>
}>
export function createTestDatabase(admin: Sql, resource: TestRoot,
  options?: { template?: TestDatabaseTemplate | undefined; name?: string }): Promise<TestDatabase>
export function resetTestDatabase(admin: Sql, resource: TestDatabase): Promise<TestDatabase>
export function assertTestDatabase(admin: Sql, resource: TestDatabase): Promise<void>
export function dropTestDatabase(admin: Sql, resource: TestDatabase, options?: { force?: boolean }): Promise<void>
export function ownedTestDatabaseUrl(variable?: string, environment?: NodeJS.ProcessEnv): string
export function createFixtureDatabase(sql: Sql, name: string, options?: string): Promise<void>
export function createMigratedFixtureDatabase(sql: Sql, name: string): Promise<void>
export function dropFixtureDatabase(sql: Sql, name: string): Promise<void>
export function createFixtureSchema(sql: Sql, name: string): Promise<void>
export function dropFixtureSchema(sql: Sql, name: string): Promise<void>
export function removeFixtureDirectory(directory: string, options?: { force: boolean }): Promise<void>
export function ownedTestPath(path: string): string
