import { z } from 'zod'
import { SavedNodePlacementSchema } from '@foreman-code/contracts/node-placement'
import { AssignedSkillSchema, GraphqlToolDefaultsSchema, GraphqlToolOverrideSchema, HarnessConfigurationSchema } from '@foreman-code/contracts'

// Raw form state is browser-only, including unfinished JSON. Publication still
// uses the shared Agent and harness validation through Save agent settings.
const HarnessFormSchema = z.object({ configuration: HarnessConfigurationSchema,
  shellEnvironmentText: z.string(), mcpText: z.string() }).strict()
export const AgentFormSchema = z.object({ base: z.string().refine((value) => { try { JSON.parse(value); return true } catch { return false } }), name: z.string(), prompt: z.string(),
  /** Persistent Agent instructions and ordered skill references; absent in forms saved before Skills v1. */
  placement: SavedNodePlacementSchema.optional(),
  branchPrefix: z.string().optional(),
  instructions: z.string().optional(), skills: z.array(AssignedSkillSchema).optional(),
  editor: HarnessFormSchema.extend({ drafts: z.object({ codex: HarnessFormSchema.optional(),
    claude: HarnessFormSchema.optional() }).strict().optional() }),
  graphqlTools: z.object({ defaults: GraphqlToolDefaultsSchema.optional(), override: GraphqlToolOverrideSchema.optional() }).strict().optional(),
}).strict()
export type AgentForm = z.infer<typeof AgentFormSchema>
