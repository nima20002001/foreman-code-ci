export const operatorTerminalHistoryMigration = { version: 285209, sql: `
  alter table operator_conversation_turns add column terminal_history jsonb;
  alter table operator_conversation_turns add column terminal_history_persisted boolean not null default false;
  update operator_conversation_turns
    set terminal_history=payload->'terminalHistory',
      terminal_history_persisted=coalesce((payload->>'terminalHistoryPersisted')::boolean,false),
      payload=payload-'terminalHistory'-'terminalHistoryPersisted'
    where payload ? 'terminalHistory' or payload ? 'terminalHistoryPersisted';
` } as const
