-- Claude Code tags each request with x-claude-code-request-class (main, subagent, workflow,
-- compaction, auxiliary); the gate copies it onto the usage event. Null for other clients and
-- for events recorded before this column existed.
alter table public.usage_events add column request_class text;
