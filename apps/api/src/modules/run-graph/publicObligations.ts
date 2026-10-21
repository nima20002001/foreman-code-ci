/** Fixed SQL aliases are part of this internal read contract: i is a durable
 * interaction, g its graph-resume row, and j a review job. Inputs remain bound
 * parameters. Save admission and compact attention must not drift on what an
 * outstanding v2 obligation means.
 */
export const PUBLIC_PENDING_INTERACTION_SQL = `i.status<>'canceled'
       and (i.status<>'delivered' or
         (i.record->>'kind' is distinct from 'work_direction' and g.approval_native_ack_id is null))`
export const PUBLIC_UNSETTLED_REVIEW_SQL = `j.state<>'completed'
       and (j.state<>'failed' or j.record->'cleanup'->>'completedAt' is null)`
