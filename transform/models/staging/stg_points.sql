-- One copy of every GPS fix. Some GeoLife ids are copies of another id's data (same second,
-- same coordinates to six decimal places, which two receivers never produce). Each such fix
-- is kept once, under the id that recorded the most fixes overall (ties: lowest id), and
-- dropped from the others. Ids that share one copied trip keep the rest of their own data.
with p as (
    select *, round(lat, 6) as lat6, round(lon, 6) as lon6
    from {{ ref('int_points_by_user') }}
),

user_size as (
    select user_id, count(*) as n from p group by 1
),

owner as (
    select p.ts_utc, p.lat6, p.lon6,
           arg_max(p.user_id, u.n * 1000 - p.user_id) as owner_id
    from p join user_size u using (user_id)
    group by 1, 2, 3
)

select p.user_id, p.ts_utc, p.ts_local, p.lat, p.lon
from p
join owner o using (ts_utc, lat6, lon6)
where p.user_id = o.owner_id
