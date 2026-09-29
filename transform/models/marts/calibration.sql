-- How often each label is given to real encounters versus fake ones. Fake encounters
-- (one side shifted by whole weeks) cannot be arranged meetings, so the share of fake
-- encounters called "meetup" or "visit" is the detector's false-alarm rate.
select pair_kind, label, count(*) as encounters,
    round(100.0 * count(*) / sum(count(*)) over (partition by pair_kind), 1) as pct_of_kind,
    round(100.0 * count(*) filter (where label not in ('unknown', 'duplicate'))
          / sum(count(*) filter (where label not in ('unknown', 'duplicate'))) over (partition by pair_kind), 1) as pct_of_judged
from {{ ref('encounter_labels') }}
group by 1, 2
