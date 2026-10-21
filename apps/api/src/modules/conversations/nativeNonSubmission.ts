import type pg from 'pg'
import { z } from 'zod'
import { ExecutionResultSchema, type ExecutionResult } from '@foreman-code/contracts'

export const NativeNonSubmissionSchema = z.object({
  requestId: z.string(),
  operation: z.enum(['session_creation', 'turn_submission']),
  result: ExecutionResultSchema,
})
export type NativeNonSubmission = z.infer<typeof NativeNonSubmissionSchema>

export function nativeNonSubmission(record: unknown, requestId: string): NativeNonSubmission | undefined {
  const parsed = z.object({ nativeNonSubmission: NativeNonSubmissionSchema }).safeParse(record)
  if (parsed.success && parsed.data.nativeNonSubmission.requestId === requestId) {
    return parsed.data.nativeNonSubmission
  }
  return undefined
}

/** Persist non-submission before cleanup, which can fail or outlive this process. */
export async function recordNativeNonSubmission(pool: pg.Pool, id: string, requestId: string,
  operation: NativeNonSubmission['operation'], result: ExecutionResult): Promise<boolean> {
  const record = NativeNonSubmissionSchema.parse({ requestId, operation, result })
  if (result.outcome === 'succeeded') throw new Error('Non-submission cannot have a successful native result.')
  const updated = await pool.query(`update operator_conversations c
    set record=c.record || jsonb_build_object('nativeNonSubmission',$3::jsonb),
      turn_state='uncertain',last_error=$4,revision=revision+1,updated_at=now()
    where c.id=$1 and c.active_request_id=$2 and c.active_native_turn_id is null
      and ($5::text <> 'session_creation' or c.native_session_id is null)
      and exists (select 1 from operator_conversation_turns t where t.conversation_id=c.id
        and t.request_id=$2 and t.native_turn_id is null and not (t.payload ? 'nativeSubmission'))`,
  [id, requestId, JSON.stringify(record), result.error?.message ?? null, operation])
  return updated.rowCount === 1
}
