-- Clean GPS fixes per user id: keep the collection period, drop impossible coordinates,
-- collapse duplicate timestamps, and remove isolated spikes (a fix that is implausibly
-- fast to reach AND to leave). Adds Beijing local time (UTC+8).
-- Copies of the same fix under several ids are still here; stg_points resolves them.
with raw as (
    select user_id, ts_utc, lat, lon
    from {{ source('geolife', 'points_raw') }}
    where ts_utc >= timestamp '2007-04-01' and ts_utc < timestamp '2012-09-01'
      and lat between -90 and 90 and lon between -180 and 180
      and not (lat = 0 and lon = 0)
),

dedup as (
    select user_id, ts_utc, avg(lat) as lat, avg(lon) as lon
    from raw
    group by 1, 2
),

neighbours as (
    select *,
        lag(lat) over w as p_lat, lag(lon) over w as p_lon, lag(ts_utc) over w as p_ts,
        lead(lat) over w as n_lat, lead(lon) over w as n_lon, lead(ts_utc) over w as n_ts
    from dedup
    window w as (partition by user_id order by ts_utc)
),

speeds as (
    select *,
        coalesce({{ haversine('p_lat', 'p_lon', 'lat', 'lon') }}
                 / greatest(epoch(ts_utc) - epoch(p_ts), 1), 0) as speed_in,
        coalesce({{ haversine('lat', 'lon', 'n_lat', 'n_lon') }}
                 / greatest(epoch(n_ts) - epoch(ts_utc), 1), 0) as speed_out
    from neighbours
)

select
    user_id,
    ts_utc,
    ts_utc + interval 8 hour as ts_local,
    lat,
    lon
from speeds
where not (speed_in > 70 and speed_out > 70)   -- 70 m/s is 250 km/h
