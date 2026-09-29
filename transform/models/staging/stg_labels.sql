-- Transport-mode labels. Taxi and car are the same thing for a phone.
select
    user_id,
    start_utc,
    end_utc,
    case when mode in ('taxi', 'car') then 'car' else mode end as mode
from {{ source('geolife', 'labels') }}
where end_utc > start_utc
