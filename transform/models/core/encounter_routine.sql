-- Per encounter and person: comparable days on which the phone was recording, and how many
-- of those the person was at this spot at this time. Plus how many OTHER people ever stop
-- within together_radius_m of the spot.
{% set r = var('together_radius_m') %}

with per_party as (
    select encounter_id, party,
        count(*) filter (where observed) as n_observed,
        count(*) filter (where observed and present) as n_present
    from {{ ref('routine_days') }}
    group by 1, 2
),

ev as (
    select encounter_id, user_a, user_b, lat, lon from {{ ref('encounters') }}
),
others as (
    select e.encounter_id, count(distinct s.user_id) as others_here
    from ev e
    join {{ ref('stays') }} s
      on h3_latlng_to_cell(s.lat, s.lon, 9) in (select unnest(h3_grid_disk(h3_latlng_to_cell(e.lat, e.lon, 9), 1)))
    where s.user_id not in (e.user_a, e.user_b)
      and {{ haversine('s.lat', 's.lon', 'e.lat', 'e.lon') }} <= {{ r }}
    group by 1
)

select e.encounter_id,
    coalesce(pa.n_observed, 0) as a_days_observed, coalesce(pa.n_present, 0) as a_days_here,
    coalesce(pb.n_observed, 0) as b_days_observed, coalesce(pb.n_present, 0) as b_days_here,
    coalesce(o.others_here, 0) as others_here
from ev e
left join per_party pa on pa.encounter_id = e.encounter_id and pa.party = 'a'
left join per_party pb on pb.encounter_id = e.encounter_id and pb.party = 'b'
left join others o on o.encounter_id = e.encounter_id
