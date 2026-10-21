/** The V3 worker-resumption writer retains the first immutable native approval
 * acknowledgement record beside its id and source. Additive; no backfill. */
export const currentApprovalAckMigration = { version: 264603, sql: String.raw`
alter table interaction_graph_resumes add column approval_native_ack_record jsonb;
` }
