-- Every time two people's stays overlap in space and time. Two sets:
--   real: the pair as recorded
--   fake: the second person's whole history shifted by fake_shift_days (whole weeks),
--         which keeps each person's weekly routine but breaks any real arrangement to meet.
-- Fake encounters are the calibration set: none of them can be a genuine meetup.
--   fake      (fake_shift_days)      is used to design the rules
--   fake_test (fake_test_shift_days) is held back and only used to report the false-alarm rate
{% set r = var('together_radius_m') %}
{% set min_s = var('together_min_minutes') * 60 %}
{% set fake_s = var('fake_shift_days') * 86400 %}
{% set test_s = var('fake_test_shift_days') * 86400 %}

with s as (
    select st.stay_id, st.user_id, st.arrive_utc, st.leave_utc, st.lat, st.lon, sp.place_id
    from {{ ref('stays') }} st join {{ ref('stay_place') }} sp using (stay_id)
),

{% for kind, shift in [('real', 0), ('fake', fake_s), ('fake_test', test_s)] %}
{{ kind }} as (
    select '{{ kind }}' as pair_kind, {{ shift }} as shift_b_s,
        a.user_id as user_a, b.user_id as user_b,
        a.stay_id as stay_a, b.stay_id as stay_b,
        a.place_id as place_a, b.place_id as place_b,
        greatest(a.arrive_utc, b.arrive_utc + to_seconds({{ shift }})) as t0_utc,
        least(a.leave_utc, b.leave_utc + to_seconds({{ shift }})) as t1_utc,
        (a.lat + b.lat) / 2 as lat, (a.lon + b.lon) / 2 as lon,
        {{ haversine('a.lat', 'a.lon', 'b.lat', 'b.lon') }} as dist_m
    from s a
    join s b
      on a.user_id < b.user_id
     and a.arrive_utc < b.leave_utc + to_seconds({{ shift }})
     and b.arrive_utc + to_seconds({{ shift }}) < a.leave_utc
    where {{ haversine('a.lat', 'a.lon', 'b.lat', 'b.lon') }} <= {{ r }}
){{ "," if not loop.last }}
{% endfor %}

select row_number() over (order by pair_kind, t0_utc, user_a, user_b) as encounter_id, *,
       (epoch(t1_utc) - epoch(t0_utc)) / 60 as minutes,
       t0_utc + interval 8 hour as t0_local,
       t1_utc + interval 8 hour as t1_local
from (select * from real union all select * from fake union all select * from fake_test)
where epoch(t1_utc) - epoch(t0_utc) >= {{ min_s }}
