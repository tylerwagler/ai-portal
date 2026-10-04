-- What the gate learns about the client, per usage event. Null for other clients and for events
-- recorded before these columns existed.
--   request_class: Claude Code's x-claude-code-request-class header (main, subagent, workflow,
--                  compaction, auxiliary).
--   client_version / client_entrypoint / client_workload: read from Claude Code's attribution block
--                  (cc_version without its fingerprint, cc_entrypoint, cc_workload).
alter table public.usage_events
  add column request_class     text,
  add column client_version    text,
  add column client_entrypoint text,
  add column client_workload   text;
create index usage_events_client_version on public.usage_events (client_version)
  where client_version is not null;
