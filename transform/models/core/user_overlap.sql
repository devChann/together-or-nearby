-- For every pair of user ids that share fixes: how many, and what share of the smaller one.
with pairs as (
    select u1.user_id as user_a, u2.user_id as user_b, s.ts_utc
    from {{ ref('shared_fixes') }} s,
         unnest(s.users) as u1(user_id), unnest(s.users) as u2(user_id)
    where u1.user_id < u2.user_id
),
counts as (select user_id, count(*) as n from {{ ref('int_points_by_user') }} group by 1)
select p.user_a, p.user_b, count(*) as shared_fixes,
       round(100.0 * count(*) / least(ca.n, cb.n), 2) as pct_of_smaller
from pairs p
join counts ca on ca.user_id = p.user_a
join counts cb on cb.user_id = p.user_b
group by p.user_a, p.user_b, ca.n, cb.n
