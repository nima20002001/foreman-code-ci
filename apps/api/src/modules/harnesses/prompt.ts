import type { HarnessExecutionRequest } from '@foreman-code/contracts'

import { HarnessExecutionError } from './errors.js'
import { legacySkillPrompt } from '../skills/instructions.js'

/** UTF-8 bytes, including system prompt, skill references, and accepted inputs. */
export const MAX_HARNESS_PROMPT_BYTES = 8 * 1024 * 1024

/** Task input for one turn. Native-v1 configurations receive their persistent instructions and
 * skills through the harness instruction channel instead, so they are never repeated here. */
export function buildHarnessPrompt<T extends Pick<HarnessExecutionRequest,
  'configuration' | 'initialPrompt' | 'executionContext' | 'input'>>(request: T): string {
  const configuration = request.configuration
  const legacy = configuration.instructionDelivery !== 'native-v1'
  const skills = configuration.assignedSkills.length > 0
    ? configuration.assignedSkills.map((skill) => `${skill.skillId}@${skill.version}`).join(', ')
    : 'None'
  const appInstructions = legacy ? [
    ...(configuration.prompt.system ? ['PRODUCT AGENT SYSTEM PROMPT', configuration.prompt.system, ''] : []),
    `ASSIGNED SKILLS: ${skills}`,
    ...legacySkillPrompt(configuration),
    '',
  ] : []
  const initialPrompt = request.initialPrompt
    ? ['INITIAL USER PROMPT', request.initialPrompt, '']
    : []
  const executionContext = request.executionContext
    ? ['TRUSTED WORKFLOW EXECUTION CONTEXT', JSON.stringify(request.executionContext), '']
    : []
  const prompt = [
    ...appInstructions,
    ...initialPrompt,
    ...executionContext,
    'ACCEPTED INPUT FROM THE WORKFLOW',
    JSON.stringify(request.input),
    '',
    'Treat the accepted input above as authoritative. Do not rediscover or replace it through files, memory, or external research.',
  ].join('\n')
  if (Buffer.byteLength(prompt, 'utf8') > MAX_HARNESS_PROMPT_BYTES) {
    throw new HarnessExecutionError('HARNESS_INPUT_TOO_LARGE', 'The combined harness prompt exceeds the 8 MiB UTF-8 input limit. Reduce the workflow input or predecessor result.')
  }
  return prompt
}
