-- GPS fixes recorded under more than one user id: same second, same coordinates to six
-- decimal places. Two independent receivers never agree that exactly, so these are copies of
-- one device's data filed under two identities (1.5 million of them in GeoLife 1.3).
select ts_utc, round(lat, 6) as lat6, round(lon, 6) as lon6,
       list(distinct user_id order by user_id) as users
from {{ ref('int_points_by_user') }}
group by 1, 2, 3
having count(distinct user_id) > 1
