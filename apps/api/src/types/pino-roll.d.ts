/** pino-roll 4 ships no types. Only the options this API uses are declared. */
declare module 'pino-roll' {
  import type SonicBoom from 'sonic-boom'
  export interface PinoRollOptions {
    file: string
    extension?: string
    frequency?: 'daily' | 'hourly' | number
    dateFormat?: string
    size?: string | number
    mkdir?: boolean
    symlink?: boolean
    sync?: boolean
    limit?: { count: number; removeOtherLogFiles?: boolean }
  }
  export default function roll(options: PinoRollOptions): Promise<SonicBoom>
}
