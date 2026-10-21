import { z } from 'zod'

const branchMessage = 'Use a valid Git branch name, such as main or release/v1.2.'
const BaseBranchSchema = z.string().trim().min(1, 'Enter a base branch.').max(255, branchMessage)
  .refine(value => !/[\s~^:?*[\]\\]/u.test(value)
    && Array.from(value).every(character => {
      const code = character.charCodeAt(0)
      return code >= 0x20 && code !== 0x7f
    })
    && !value.startsWith('-') && !value.endsWith('.') && value !== '@'
    && !value.includes('..') && !value.includes('@{')
    && value.split('/').every(part => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock')),
  branchMessage)

/** Each computer keeps its own clone of the workspace's GitHub repository. */
export const WorkspaceRepositorySchema = z.object({
  provider: z.literal('github'),
  owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
  name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/).refine(value => value !== '.' && value !== '..'),
  defaultBranch: BaseBranchSchema,
}).strict()
export type WorkspaceRepository = z.infer<typeof WorkspaceRepositorySchema>

/** A public GitHub repository that runs this workspace's CI on free GitHub Actions runners. Main pushes each tested
 * commit's files there as one new commit without the private history, after checking them for this fleet's home
 * paths, user and computer names and Tailscale addresses. */
export const WorkspaceCiMirrorSchema = z.object({
  provider: z.literal('github'),
  owner: WorkspaceRepositorySchema.shape.owner,
  name: WorkspaceRepositorySchema.shape.name,
}).strict()
export type WorkspaceCiMirror = z.infer<typeof WorkspaceCiMirrorSchema>
