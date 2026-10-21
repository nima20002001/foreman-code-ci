import { z } from 'zod'

export const RemoteOperationPhaseSchema = z.enum(['received', 'native_entry_attempted', 'start_acknowledged', 'running', 'stop_requested', 'confirmed_terminal', 'uncertain'])
