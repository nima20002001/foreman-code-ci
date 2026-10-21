import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { z } from 'zod'
import { DomainError } from '../../errors.js'

const path=z.string().startsWith('/').refine(value=>!value.includes('\0')&&!value.includes('\n'))
/** Installer selection only. Qualification, login, source and launch authority are read from their actual producers. */
const version = z.string().trim().min(1).max(64)
const payloadPaths = z.array(path).max(16)
export const InstalledWorkflowConfigurationSchema = z.object({
  schemaVersion: z.literal(1),
  codexBinary: path.optional(),
  appMcpLauncher: path,
  expectedVersion: version.optional(),
  payloadPaths: payloadPaths.optional(),
  claude: z.object({ binary: path, installedLockPath: path, sdkEntrypoint: path.optional() }).strict().optional(),
}).strict().superRefine((value, context) => {
  const codexSelected = value.codexBinary !== undefined || value.expectedVersion !== undefined
    || value.payloadPaths !== undefined
  if (codexSelected && (!value.codexBinary || !value.expectedVersion || !value.payloadPaths)) {
    context.addIssue({ code: 'custom', message: 'The Codex selection requires its binary, version and payload paths.' })
  }
  if (!codexSelected && !value.claude) {
    context.addIssue({ code: 'custom', message: 'Select at least one installed workflow harness.' })
  }
})
export type InstalledWorkflowConfiguration=z.infer<typeof InstalledWorkflowConfigurationSchema>
export function installedHarnessSelection(configuration: InstalledWorkflowConfiguration) {
  if (!configuration.codexBinary || !configuration.expectedVersion || !configuration.payloadPaths) return null
  return { binary: configuration.codexBinary, expectedVersion: configuration.expectedVersion,
    payloadPaths: configuration.payloadPaths }
}
export interface InstalledWorkflowConfigurationLocation {path:string;ownerUid:number}
function unavailable(reason:string):never {
  throw new DomainError('WORKER_WORKFLOW_UNAVAILABLE','The installed workflow selection is unavailable.',409,{reason})
}
export async function readInstalledWorkflowConfiguration(location:InstalledWorkflowConfigurationLocation|null):Promise<InstalledWorkflowConfiguration|null> {
  if(!location)return null
  if(!Number.isSafeInteger(location.ownerUid)||location.ownerUid<0||!location.path.startsWith('/'))unavailable('invalid_configuration_location')
  let file:Awaited<ReturnType<typeof open>>|undefined
  try {
    if(await realpath(location.path)!==location.path)unavailable('configuration_retargeted')
    file=await open(location.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
    const before=await file.stat()
    if(!before.isFile()||before.uid!==location.ownerUid||before.mode&0o077||before.nlink!==1||before.size>65536)unavailable('configuration_not_private')
    const bytes=await file.readFile(),after=await file.stat()
    if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)unavailable('configuration_changed')
    return InstalledWorkflowConfigurationSchema.parse(JSON.parse(bytes.toString('utf8')))
  } catch(error) {
    if(error instanceof DomainError)throw error
    return unavailable('configuration_invalid_or_missing')
  } finally {await file?.close()}
}
