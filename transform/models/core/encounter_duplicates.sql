-- Real encounters backed by copied data: the two ids share identical fixes within two hours
-- of the encounter. Such an encounter is one device seen twice, not two people.
with ev as (
    select encounter_id, user_a, user_b, t0_utc, t1_utc
    from {{ ref('encounters') }} where pair_kind = 'real'
)
select e.encounter_id, count(s.ts_utc) as shared_fixes
from ev e
left join {{ ref('shared_fixes') }} s
  on list_contains(s.users, e.user_a) and list_contains(s.users, e.user_b)
 and s.ts_utc between e.t0_utc - interval 2 hour and e.t1_utc + interval 2 hour
group by 1
