import { afterAll, beforeAll } from 'vitest'
import type { WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './currentOperatorIntegration.js'
import { migratedDatabase } from './migratedDatabase.js'

export function setupWorkflowCreateIntegration() {
  let database: Awaited<ReturnType<typeof migratedDatabase>> | undefined
  beforeAll(async () => {
    database = await migratedDatabase()
  }, 120_000)
  afterAll(async () => {
    await database?.close()
  }, 120_000)

  return (options: Parameters<typeof currentOperatorIntegration>[0] = {}) => {
    if (!database) throw new Error('Workflow creation database is not initialized')
    return currentOperatorIntegration({ ...options, database })
  }
}

export function initialSave(graph: WorkflowDefinitionV3, configurations: Record<string, string>) {
  const { id, workspaceId, name, description, defaultWorktree, version, createdAt, updatedAt, ...definition } = graph
  void id
  void workspaceId
  void name
  void description
  void defaultWorktree
  void version
  void createdAt
  void updatedAt
  return { graph: definition, expectedAgentConfigurationVersionIds: configurations }
}
