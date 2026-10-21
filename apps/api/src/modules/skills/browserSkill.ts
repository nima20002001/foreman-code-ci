import { readFile } from 'node:fs/promises'
import type { ResolvedSkill } from '@foreman-code/contracts'
import { skillHash } from './instructions.js'

export const managedBrowserSkillId = 'foreman-browser-use'

/** Save captures the packaged skill bytes; native launches consume only that saved snapshot. */
export async function readManagedBrowserSkill(): Promise<ResolvedSkill> {
  const instructions = await readFile(new URL('../browser-runtime/skill/browser-use.md', import.meta.url), 'utf8')
  const contentHash = skillHash(instructions)
  return { skillId: managedBrowserSkillId, version: contentHash, name: 'Managed browser', instructions, contentHash }
}
