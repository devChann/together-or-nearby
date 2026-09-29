-- One label per encounter.
--   routine      both usually there at that time (same office, same gym slot)
--   meetup       neither usually there, and they came and went together
--                (or did one of the two at a spot that is normally empty at that time)
--   visit        one usually there, the other not, at a private spot (few other visitors ever)
--   coincidence  same place and time, but nothing else says they were together
--   mixed        routine rates in between
--   unknown      not enough comparable recorded days to judge
{% set usually = var('usually_here') %}
{% set rarely = var('rarely_here') %}
{% set gap = var('together_gap_minutes') %}

with x as (
    select e.*, r.* exclude (encounter_id), c.* exclude (encounter_id),
        coalesce(d.shared_fixes, 0) as shared_fixes,
        ga.source_group = gb.source_group as linked_ids,
        r.a_days_here / nullif(r.a_days_observed, 0) as rate_a,
        r.b_days_here / nullif(r.b_days_observed, 0) as rate_b
    from {{ ref('encounters') }} e
    join {{ ref('encounter_routine') }} r using (encounter_id)
    join {{ ref('encounter_context') }} c using (encounter_id)
    left join {{ ref('encounter_duplicates') }} d using (encounter_id)
    join {{ ref('source_groups') }} ga on ga.user_id = e.user_a
    join {{ ref('source_groups') }} gb on gb.user_id = e.user_b
),

y as (
    select *,
        arrive_gap_min <= {{ gap }} as arrived_together,
        leave_gap_min <= {{ gap }} as left_together,
        crowd_typical = 0 as usually_empty
    from x
),

homes as (
    select user_id, lat, lon from {{ ref('places') }} where is_home
)

select y.*,
    case
        when shared_fixes > 0 or linked_ids then 'duplicate'
        when a_days_observed < {{ var('min_days_observed') }}
          or b_days_observed < {{ var('min_days_observed') }} then 'unknown'
        when rate_a >= {{ usually }} and rate_b >= {{ usually }} then 'routine'
        when rate_a < {{ rarely }} and rate_b < {{ rarely }} then
            case when arrived_together and left_together then 'meetup'
                 when (arrived_together or left_together) and usually_empty then 'meetup'
                 else 'coincidence' end
        when greatest(rate_a, rate_b) >= {{ usually }} and least(rate_a, rate_b) < {{ rarely }} then
            case when others_here <= {{ var('private_max_others') }} then 'visit' else 'coincidence' end
        else 'mixed'
    end as label,
    exists (select 1 from homes h where h.user_id = y.user_a
            and {{ haversine('h.lat', 'h.lon', 'y.lat', 'y.lon') }} <= 300) as at_home_a,
    exists (select 1 from homes h where h.user_id = y.user_b
            and {{ haversine('h.lat', 'h.lon', 'y.lat', 'y.lon') }} <= 300) as at_home_b,
    isodow(t0_local) >= 6 as is_weekend,
    hour(t0_local) as local_hour
from y
