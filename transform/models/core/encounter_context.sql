-- Two more signals per encounter:
--   crowd_now      other people stopped at the spot during the encounter itself
--   crowd_typical  other people seen at the spot at this time of day on comparable days
--                  (same weekday/weekend kind, within routine_window_days)
--   arrive_gap_min / leave_gap_min  how far apart the two people arrived and left
{% set r = var('together_radius_m') %}
{% set w = var('routine_window_days') %}

with ev as (
    select e.encounter_id, e.user_a, e.user_b, e.lat, e.lon, e.t0_utc, e.t1_utc, e.shift_b_s,
        cast(e.t0_local as date) as local_day,
        e.t0_local - cast(cast(e.t0_local as date) as timestamp) as tod0,
        e.t1_local - cast(cast(e.t0_local as date) as timestamp) as tod1,
        isodow(e.t0_local) >= 6 as is_weekend,
        sa.arrive_utc as a_arrive, sa.leave_utc as a_leave,
        sb.arrive_utc + to_seconds(e.shift_b_s) as b_arrive,
        sb.leave_utc + to_seconds(e.shift_b_s) as b_leave
    from {{ ref('encounters') }} e
    join {{ ref('stays') }} sa on sa.stay_id = e.stay_a
    join {{ ref('stays') }} sb on sb.stay_id = e.stay_b
),

near_others as (
    select e.encounter_id, s.user_id, s.arrive_utc, s.leave_utc
    from ev e
    join {{ ref('stays') }} s
      on h3_latlng_to_cell(s.lat, s.lon, 9) in (select unnest(h3_grid_disk(h3_latlng_to_cell(e.lat, e.lon, 9), 1)))
    where s.user_id not in (e.user_a, e.user_b)
      and {{ haversine('s.lat', 's.lon', 'e.lat', 'e.lon') }} <= {{ r }}
),

now_crowd as (
    select e.encounter_id, count(distinct n.user_id) as crowd_now
    from ev e join near_others n using (encounter_id)
    where n.arrive_utc < e.t1_utc and e.t0_utc < n.leave_utc
    group by 1
),

cand as (
    select e.encounter_id,
        cast(c.cand_day as timestamp) + e.tod0 - interval 8 hour as w0,
        cast(c.cand_day as timestamp) + e.tod1 - interval 8 hour as w1
    from ev e
    cross join lateral (
        select cast(unnest(generate_series(cast(e.local_day as timestamp) - interval {{ w }} day,
                                           cast(e.local_day as timestamp) + interval {{ w }} day,
                                           interval 1 day)) as date) as cand_day
    ) c
    where c.cand_day <> e.local_day and (isodow(c.cand_day) >= 6) = e.is_weekend
),

typical_crowd as (
    select c.encounter_id, count(distinct n.user_id) as crowd_typical
    from cand c join near_others n using (encounter_id)
    where n.arrive_utc < c.w1 and c.w0 < n.leave_utc
    group by 1
)

select e.encounter_id,
    coalesce(nc.crowd_now, 0) as crowd_now,
    coalesce(tc.crowd_typical, 0) as crowd_typical,
    abs(epoch(e.a_arrive) - epoch(e.b_arrive)) / 60 as arrive_gap_min,
    abs(epoch(e.a_leave) - epoch(e.b_leave)) / 60 as leave_gap_min
from ev e
left join now_crowd nc using (encounter_id)
left join typical_crowd tc using (encounter_id)
