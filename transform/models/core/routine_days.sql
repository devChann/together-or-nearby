-- The evidence behind each routine rate, one row per encounter, person and comparable day
-- (same weekday/weekend kind, within routine_window_days, excluding the encounter's own day).
--   observed = the person has a GPS fix or a stay within 30 min of the window that day
--   present  = the person has a stay within together_radius_m that overlaps the window
{% set r = var('together_radius_m') %}
{% set w = var('routine_window_days') %}

with ev as (
    select encounter_id, pair_kind, shift_b_s, user_a, user_b, lat, lon, t0_utc, t1_utc,
        cast(t0_local as date) as local_day,
        t0_local - cast(cast(t0_local as date) as timestamp) as tod0,
        t1_local - cast(cast(t0_local as date) as timestamp) as tod1,
        isodow(t0_local) >= 6 as is_weekend
    from {{ ref('encounters') }}
),

parties as (
    select encounter_id, 'a' as party, user_a as user_id, 0 as shift_s from ev
    union all
    select encounter_id, 'b' as party, user_b as user_id, shift_b_s as shift_s from ev
),

cand as (
    select p.encounter_id, p.party, p.user_id, c.cand_day,
        cast(c.cand_day as timestamp) + e.tod0 - interval 8 hour - to_seconds(p.shift_s) as w0,
        cast(c.cand_day as timestamp) + e.tod1 - interval 8 hour - to_seconds(p.shift_s) as w1
    from parties p
    join ev e using (encounter_id)
    cross join lateral (
        select cast(unnest(generate_series(cast(e.local_day as timestamp) - interval {{ w }} day,
                                           cast(e.local_day as timestamp) + interval {{ w }} day,
                                           interval 1 day)) as date) as cand_day
    ) c
    where c.cand_day <> e.local_day
      and (isodow(c.cand_day) >= 6) = e.is_weekend
),

coverage as (
    select distinct user_id, date_trunc('hour', ts_utc) as hr from {{ ref('stg_points') }}
    union
    select user_id, unnest(generate_series(date_trunc('hour', arrive_utc),
                                           date_trunc('hour', leave_utc), interval 1 hour)) as hr
    from {{ ref('stays') }}
),

cand_hours as (
    select encounter_id, party, user_id, cand_day,
        unnest(generate_series(date_trunc('hour', w0 - interval 30 minute),
                               date_trunc('hour', w1 + interval 30 minute), interval 1 hour)) as hr
    from cand
),

observed as (
    select distinct ch.encounter_id, ch.party, ch.cand_day
    from cand_hours ch
    join coverage cv on cv.user_id = ch.user_id and cv.hr = ch.hr
),

near as (
    select p.encounter_id, p.party, s.arrive_utc, s.leave_utc
    from parties p
    join ev e using (encounter_id)
    join {{ ref('stays') }} s on s.user_id = p.user_id
    where {{ haversine('s.lat', 's.lon', 'e.lat', 'e.lon') }} <= {{ r }}
),

present as (
    select distinct c.encounter_id, c.party, c.cand_day
    from cand c
    join near n on n.encounter_id = c.encounter_id and n.party = c.party
    where least(epoch(n.leave_utc), epoch(c.w1)) - greatest(epoch(n.arrive_utc), epoch(c.w0))
          >= least(600, epoch(c.w1) - epoch(c.w0))
)

select c.encounter_id, c.party, c.cand_day,
    o.cand_day is not null as observed,
    p.cand_day is not null as present
from cand c
left join observed o using (encounter_id, party, cand_day)
left join present p using (encounter_id, party, cand_day)
