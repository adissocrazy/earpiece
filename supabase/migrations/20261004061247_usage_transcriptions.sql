-- Voice replies (Reply from the notch): hosted speech-to-text, counted per user per month.
alter table public.usage add column if not exists transcriptions int not null default 0;

drop function if exists public.record_usage(uuid, int, int, int, int);
create function public.record_usage(uid uuid, p_lines int, p_chars int, p_summaries int, p_fallbacks int, p_transcriptions int default 0)
returns int
language sql volatile security definer set search_path = ''
as $$
  insert into public.usage as u (user_id, month, lines, chars, summaries, fallbacks, transcriptions)
  values (uid, date_trunc('month', now() at time zone 'utc')::date, p_lines, p_chars, p_summaries, p_fallbacks, p_transcriptions)
  on conflict (user_id, month) do update set
    lines = u.lines + excluded.lines, chars = u.chars + excluded.chars,
    summaries = u.summaries + excluded.summaries, fallbacks = u.fallbacks + excluded.fallbacks,
    transcriptions = u.transcriptions + excluded.transcriptions
  returning lines;
$$;
revoke execute on function public.record_usage(uuid, int, int, int, int, int) from public, anon, authenticated;
grant execute on function public.record_usage(uuid, int, int, int, int, int) to service_role;
