/** Main prepares its own CI runtime too: a preparation's computer is a paired device or Main, which names itself
 * by its installation id (the canonical alias Main already uses for itself as a computer). */
export const ciRuntimeMainComputerMigration = { version: 2026100902, sql: String.raw`
alter table ci_runtime_preparations drop constraint ci_runtime_preparations_device_id_fkey;
` }
