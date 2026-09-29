-- One row per recurring place, with how much of the night and the working day a person
-- spends there. Home = the place with most time between midnight and 06:00 (local);
-- work = the place with most weekday time between 10:00 and 16:00, other than home.
with s as (
    select st.*, sp.place_id,
           st.arrive_utc + interval 8 hour as arrive_local,
           st.leave_utc + interval 8 hour as leave_local
    from {{ ref('stays') }} st
    join {{ ref('stay_place') }} sp using (stay_id)
),

days as (
    select s.stay_id, s.place_id, s.user_id, s.arrive_local, s.leave_local,
           unnest(generate_series(date_trunc('day', s.arrive_local),
                                  date_trunc('day', s.leave_local), interval 1 day)) as day
    from s
),

windows as (
    select place_id, user_id,
        greatest(epoch(least(leave_local, day + interval 6 hour))
                 - epoch(greatest(arrive_local, day)), 0) / 3600 as night_h,
        case when isodow(day) <= 5 then
            greatest(epoch(least(leave_local, day + interval 16 hour))
                     - epoch(greatest(arrive_local, day + interval 10 hour)), 0) / 3600
        else 0 end as work_h
    from days
),

dwell as (
    select place_id, sum(night_h) as night_h, sum(work_h) as work_h
    from windows group by 1
),

agg as (
    select place_id, any_value(user_id) as user_id,
        sum(lat * minutes) / sum(minutes) as lat,
        sum(lon * minutes) / sum(minutes) as lon,
        count(*) as n_stays,
        sum(minutes) / 60 as total_h,
        count(distinct cast(arrive_local as date)) as n_days
    from s group by 1
),

ranked as (
    select a.*, d.night_h, d.work_h,
        row_number() over (partition by a.user_id order by d.night_h desc) as night_rank
    from agg a join dwell d using (place_id)
),

with_home as (
    select *, (night_rank = 1 and night_h >= 2) as is_home
    from ranked
),

work_ranked as (
    select *,
        row_number() over (partition by user_id order by case when is_home then -1 else work_h end desc) as work_rank
    from with_home
)

select place_id, user_id, lat, lon, n_stays, n_days, total_h, night_h, work_h, is_home,
       (work_rank = 1 and not is_home and work_h >= 4) as is_work,
       h3_latlng_to_cell(lat, lon, 9) as h3_9
from work_ranked
