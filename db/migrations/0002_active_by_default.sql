-- New accounts are active on the free tier at once; free-tier limits are the guard.
-- 'pending' stays a valid role for holding an account by hand.
alter table public.profiles alter column role set default 'user';
