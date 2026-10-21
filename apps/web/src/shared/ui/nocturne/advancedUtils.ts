/** Toolkit view helpers, not harness/API contracts. No hidden defaults are sent to a server. */
export type SettingValue = string | boolean
export interface SettingOption { value: string; label: string; disabled?: boolean }
export interface SettingDefinition {
  id: string; label: string; section: string; description?: string; keywords?: string
  type: 'text' | 'textarea' | 'number' | 'select' | 'switch'
  advanced?: boolean; readOnly?: boolean; unavailableReason?: string; required?: boolean
  options?: readonly SettingOption[]; min?: number; max?: number; step?: number; maxLength?: number
  source?: string; overridden?: boolean; secret?: boolean
}
export function validateSetting(field: SettingDefinition, value: SettingValue | undefined): string | undefined {
  if (field.readOnly || field.unavailableReason) return undefined
  const text = typeof value === 'string' ? value.trim() : ''
  if (field.type === 'switch') return typeof value === 'boolean' ? undefined : 'Choose on or off.'
  if (field.required && !text) return 'This field is required.'
  if (!text) return undefined
  if (field.maxLength !== undefined && String(value).length > field.maxLength) return `Use ${field.maxLength} characters or fewer.`
  if (field.type === 'select' && !field.options?.some(option => option.value === value && !option.disabled)) return 'Choose an available option.'
  if (field.type === 'number') {
    const number = Number(text)
    if (!Number.isFinite(number)) return 'Enter a finite number.'
    if (field.min !== undefined && number < field.min) return `Minimum is ${field.min}.`
    if (field.max !== undefined && number > field.max) return `Maximum is ${field.max}.`
    if (field.step && field.step > 0) {
      const steps = (number - (field.min ?? 0)) / field.step
      if (Math.abs(steps - Math.round(steps)) > 1e-8) return `Use increments of ${field.step}.`
    }
  }
  return undefined
}
export function matchingSettings(fields: readonly SettingDefinition[], query: string, advanced: boolean) {
  const search = query.trim().toLocaleLowerCase()
  return fields.filter(field => (!field.advanced || advanced || search.length > 0) &&
    (!search || [field.label, field.section, field.description, field.keywords].filter(Boolean).join(' ').toLocaleLowerCase().includes(search)))
}
export function displaySetting(value: SettingValue | undefined, secret = false): string {
  if (secret) return value ? '•••••••• (redacted)' : 'Not set'
  if (value === undefined || value === '') return 'Not set'
  return typeof value === 'boolean' ? value ? 'Enabled' : 'Disabled' : value
}
export function frameAt(index: number, length: number): number {
  const total = Number.isFinite(length) ? Math.max(0, Math.floor(length)) : 0
  return Math.max(0, Math.min(Math.max(0, total - 1), Number.isFinite(index) ? Math.floor(index) : 0))
}
export function fileSelectionErrors(files: readonly Pick<File, 'name' | 'size'>[], maxFiles: number, maxBytes: number, extensions: readonly string[]): string[] {
  const errors: string[] = []
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || !Number.isFinite(maxBytes) || maxBytes < 1) return ['File selection limits are unavailable.']
  if (files.length > maxFiles) errors.push(`Choose up to ${maxFiles} files.`)
  for (const file of files) {
    if (file.size > maxBytes) errors.push(`${file.name}: exceeds the size limit.`)
    if (extensions.length && !extensions.some(ext => file.name.toLowerCase().endsWith(ext.toLowerCase()))) errors.push(`${file.name}: unsupported file type.`)
  }
  return errors
}
