export const memoryWorkIndexesMigration = { version: 2026102102, sql: `
create index memory_bindings_card_page on memory_card_bindings(card_id,
  (case when record->'resolution' is null and record->>'state'<>'accepted' then 0 else 1 end),id);
create index memory_bindings_unresolved on memory_card_bindings(card_id)
  where record->'resolution' is null and record->>'state'<>'accepted';
create index memory_claims_card_page on memory_card_claims(card_id,
  (case when state='armed' then 0 else 1 end),id);
create index memory_bindings_run_unresolved on memory_card_bindings((record#>>'{work,runId}'))
  where record->'resolution' is null and record->>'state' not in ('accepted','failed','canceled');
` }
