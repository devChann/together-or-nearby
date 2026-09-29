"""Export what the public inspector needs to docs/data (GitHub Pages serves docs/).

Privacy: GeoLife is anonymised, but a public page should still never show where anyone
sleeps. Every GPS fix and stay within HOME_BLUR_M of ANY detected home is dropped, and an
encounter at such a spot is shown only as a coarse H3 hexagon (resolution 8, ~0.7 km2).
"""
import json
import math
import pathlib

import duckdb
import h3
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
DB = ROOT / "data/warehouse.duckdb"
OUT = ROOT / "docs/data"
HOME_BLUR_M = 300
PAD_MIN = 120          # show this much before and after each encounter
MIN_SPACING_S = 20     # thin tracks to one fix per 20 s


def hav(lat1, lon1, lat2, lon2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(np.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6371000 * np.arcsin(np.sqrt(a))


def wilson(k, n, z=1.96):
    if n == 0:
        return [0, 0]
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(100 * (c - h), 1), round(100 * (c + h), 1)]


def near_home(lat, lon, homes):
    if len(homes) == 0:
        return np.zeros(len(lat), bool)
    d = hav(lat[:, None], lon[:, None], homes[None, :, 0], homes[None, :, 1])
    return (d < HOME_BLUR_M).any(axis=1)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "enc").mkdir(exist_ok=True)
    con = duckdb.connect(str(DB), read_only=True)
    con.execute(f"CREATE TEMP VIEW trips AS SELECT * FROM '{ROOT}/data/lake/trips.parquet'")
    homes = con.execute("select lat, lon from places where is_home").fetchnumpy()
    homes = np.column_stack([homes["lat"], homes["lon"]]) if len(homes["lat"]) else np.zeros((0, 2))

    # ---------- summary ----------
    q = lambda sql: con.execute(sql).fetchall()
    ds = dict(zip(["points", "users"], q("select count(*), count(distinct user_id) from stg_points")[0]))
    ds["copies_removed"] = q("select (select count(*) from int_points_by_user) - (select count(*) from stg_points)")[0][0]
    ds["stays"], ds["places"] = q("select (select count(*) from stays), (select count(*) from places)")[0]
    ds["homes"] = int(len(homes))
    ds["encounters"], ds["pairs"], ds["judged"], ds["duplicate"] = q(
        "select count(*), count(distinct (user_a, user_b)), "
        "count(*) filter (where label not in ('unknown', 'duplicate')), count(*) filter (where label = 'duplicate') "
        "from encounter_labels where pair_kind = 'real'")[0]
    quality = {
        "shared_fixes": q("select count(*) from shared_fixes")[0][0],
        "groups": [r[0] for r in q("select list(user_id order by user_id) from source_groups "
                                   "group by source_group having count(*) > 1 order by min(user_id)")],
        "worst_pairs": [dict(zip(["a", "b", "shared", "pct"], r)) for r in
                        q("select user_a, user_b, shared_fixes, pct_of_smaller from user_overlap "
                          "order by shared_fixes desc limit 6")],
        "mode_accuracy_grouped_by_user": 0.812,
        # Measured on the first run, before copied fixes were removed at source:
        "first_run": {"encounters": 2311, "flagged": 1310, "flagged_pct": 65.4},
    }

    calib = {}
    for kind, label, n, pct_judged in q("select pair_kind, label, encounters, pct_of_judged from calibration"):
        calib.setdefault(kind, {})[label] = {"n": n, "pct": pct_judged}
    flagged = {}
    for kind, judged, k in q("select pair_kind, count(*) filter (where label not in ('unknown', 'duplicate')), "
                             "count(*) filter (where label in ('meetup','visit')) from encounter_labels group by 1"):
        flagged[kind] = {"judged": judged, "flagged": k, "pct": round(100 * k / judged, 1), "ci95": wilson(k, judged)}

    signals = {}
    for kind, n, arr, left, empty in q("""
        select pair_kind, count(*), avg(arrived_together::int), avg(left_together::int), avg(usually_empty::int)
        from encounter_labels
        where pair_kind in ('real', 'fake') and label not in ('unknown', 'duplicate')
          and rate_a < 0.25 and rate_b < 0.25 group by 1"""):
        signals[kind] = {"n": n, "arrived_together": round(100 * arr), "left_together": round(100 * left),
                         "usually_empty": round(100 * empty)}

    when = {}
    for label in ("routine", "meetup", "coincidence"):
        grid = [[0] * 24 for _ in range(7)]
        for dow, hr, n in q(f"select isodow(t0_local), hour(t0_local), count(*) from encounter_labels "
                            f"where pair_kind = 'real' and label = '{label}' group by 1, 2"):
            grid[dow - 1][hr] = n
        when[label] = grid
    timing = {r[0]: {"n": r[1], "weekend": round(100 * r[2]), "weekday_9_17": round(100 * r[3]),
                     "evening": round(100 * r[4]), "median_min": round(r[5])}
              for r in q("""select label, count(*), avg(is_weekend::int),
                                   avg((not is_weekend and local_hour between 9 and 17)::int),
                                   avg((local_hour >= 18 or local_hour < 6)::int), median(minutes)
                            from encounter_labels where pair_kind = 'real' and label not in ('unknown', 'duplicate') group by 1""")}

    pairs = [dict(zip(["a", "b", "encounters", "duplicate", "meetups", "routine", "coincidence", "hours", "first", "last"], r))
             for r in q("""select user_a, user_b, count(*), count(*) filter (where label = 'duplicate'),
                                  count(*) filter (where label = 'meetup'), count(*) filter (where label = 'routine'),
                                  count(*) filter (where label = 'coincidence'), round(sum(minutes) / 60, 1),
                                  strftime(min(t0_local), '%Y-%m-%d'), strftime(max(t0_local), '%Y-%m-%d')
                           from encounter_labels where pair_kind = 'real' group by 1, 2 order by 3 desc""")]

    modes = json.loads((ROOT / "results/modes.json").read_text())
    summary = {"dataset": ds, "quality": quality, "calibration": calib, "flagged": flagged, "signals": signals,
               "when": when, "timing": timing, "pairs": pairs[:40], "modes": modes,
               "params": {"stay_radius_m": 200, "stay_min_minutes": 20, "together_radius_m": 150,
                          "together_min_minutes": 10, "routine_window_days": 42, "together_gap_minutes": 10,
                          "usually_here": 0.5, "rarely_here": 0.25, "private_max_others": 2,
                          "fake_shift_days": 35, "fake_test_shift_days": 63, "home_blur_m": HOME_BLUR_M}}

    # ---------- showcase selection ----------
    pick = []
    for label, per_pair, cap in (("meetup", 3, 60), ("routine", 2, 15), ("coincidence", 2, 15),
                                 ("mixed", 1, 8), ("visit", 1, 2), ("duplicate", 1, 4)):
        pick += [r[0] for r in q(f"""
            select encounter_id from (
                select encounter_id, minutes,
                       row_number() over (partition by user_a, user_b order by minutes desc) as k
                from encounter_labels where pair_kind = 'real' and label = '{label}')
            where k <= {per_pair} order by minutes desc limit {cap}""")]
    pick += [r[0] for r in q("select encounter_id from encounter_labels where pair_kind = 'fake_test' "
                             "and label in ('meetup', 'visit')")]
    pick += [r[0] for r in q("select encounter_id from encounter_labels where pair_kind = 'fake_test' "
                             "and label = 'coincidence' order by minutes desc limit 6")]

    cols = [d[0] for d in con.execute("select * from encounter_labels limit 0").description]
    index = []
    for eid in pick:
        e = dict(zip(cols, con.execute("select * from encounter_labels where encounter_id = ?", [eid]).fetchone()))
        shift = int(e["shift_b_s"])
        t0, t1 = e["t0_utc"], e["t1_utc"]
        loc_private = bool(near_home(np.array([e["lat"]]), np.array([e["lon"]]), homes)[0])

        tracks, stays_out, trips_out = {}, [], []
        for party, uid, sh in (("a", e["user_a"], 0), ("b", e["user_b"], shift)):
            pts = con.execute("""
                select epoch(ts_utc)::BIGINT + ? as t, lat, lon from stg_points
                where user_id = ? and ts_utc between ? - to_seconds(?) - interval (?) minute
                                                  and ? - to_seconds(?) + interval (?) minute
                order by ts_utc""", [sh, uid, t0, sh, PAD_MIN, t1, sh, PAD_MIN]).fetchnumpy()
            t, la, lo = pts["t"], pts["lat"], pts["lon"]
            keep = ~near_home(la, lo, homes) if len(t) else np.zeros(0, bool)
            last, rows = -10 ** 12, []
            for ti, ai, oi, k in zip(t, la, lo, keep):
                if k and ti - last >= MIN_SPACING_S:
                    rows.append([round(float(oi), 5), round(float(ai), 5), round((ti - t0.timestamp()) / 60, 1)])
                    last = ti
            tracks[party] = rows

            for sid, sla, slo, arr, lea, rad in con.execute("""
                select stay_id, lat, lon, epoch(arrive_utc)::BIGINT + ?, epoch(leave_utc)::BIGINT + ?, radius_m
                from stays where user_id = ?
                  and arrive_utc < ? - to_seconds(?) + interval (?) minute
                  and leave_utc > ? - to_seconds(?) - interval (?) minute""",
                    [sh, sh, uid, t1, sh, PAD_MIN, t0, sh, PAD_MIN]).fetchall():
                private = bool(near_home(np.array([sla]), np.array([slo]), homes)[0])
                stays_out.append({"who": party, "private": private,
                                  "lat": None if private else round(sla, 5), "lon": None if private else round(slo, 5),
                                  "r": round(rad), "from": round((arr - t0.timestamp()) / 60, 1),
                                  "to": round((lea - t0.timestamp()) / 60, 1)})
            for mode, conf, s0, s1, km in con.execute("""
                select mode, mode_confidence, epoch(start_utc)::BIGINT + ?, epoch(end_utc)::BIGINT + ?, km
                from trips where user_id = ?
                  and start_utc < ? - to_seconds(?) + interval (?) minute
                  and end_utc > ? - to_seconds(?) - interval (?) minute""",
                    [sh, sh, uid, t1, sh, PAD_MIN, t0, sh, PAD_MIN]).fetchall():
                trips_out.append({"who": party, "mode": mode, "conf": conf, "km": round(km, 1),
                                  "from": round((s0 - t0.timestamp()) / 60, 1), "to": round((s1 - t0.timestamp()) / 60, 1)})

        evidence = {"a": [], "b": []}
        day0 = e["t0_local"].date()
        for party, day, obs, pres in con.execute(
                "select party, cand_day, observed, present from routine_days where encounter_id = ? order by cand_day",
                [eid]).fetchall():
            evidence[party].append([(day - day0).days, int(obs), int(pres)])

        rec = {
            "id": eid, "kind": e["pair_kind"], "label": e["label"], "a": e["user_a"], "b": e["user_b"],
            "shift_days": shift // 86400,
            "start": e["t0_local"].strftime("%Y-%m-%d %H:%M"), "end": e["t1_local"].strftime("%H:%M"),
            "weekday": e["t0_local"].strftime("%A"), "minutes": round(e["minutes"]),
            "private": loc_private,
            "lat": None if loc_private else round(e["lat"], 5), "lon": None if loc_private else round(e["lon"], 5),
            "hex": ([[round(lo, 5), round(la, 5)] for la, lo in h3.cell_to_boundary(h3.latlng_to_cell(e["lat"], e["lon"], 8))]
                    if loc_private else None),
            "center": [round(e["lon"], 3), round(e["lat"], 3)] if loc_private else [round(e["lon"], 5), round(e["lat"], 5)],
            "a_days": [e["a_days_here"], e["a_days_observed"]], "b_days": [e["b_days_here"], e["b_days_observed"]],
            "others_here": e["others_here"], "crowd_now": e["crowd_now"], "crowd_typical": e["crowd_typical"],
            "arrive_gap": round(e["arrive_gap_min"]), "leave_gap": round(e["leave_gap_min"]),
            "evidence": evidence, "tracks": tracks, "stays": stays_out, "trips": trips_out,
        }
        (OUT / "enc" / f"{eid}.json").write_text(json.dumps(rec, separators=(",", ":")))
        rec["shared_fixes"] = int(e["shared_fixes"])
        rec["linked"] = bool(e["linked_ids"])
        index.append({k: rec[k] for k in ("id", "kind", "label", "a", "b", "start", "end", "weekday", "minutes",
                                          "private", "a_days", "b_days", "arrive_gap", "leave_gap",
                                          "crowd_typical", "others_here", "shared_fixes")})

    summary["showcase"] = index
    (OUT / "summary.json").write_text(json.dumps(summary, separators=(",", ":"), default=str))
    size = sum(p.stat().st_size for p in OUT.rglob("*.json"))
    print(f"exported {len(index)} encounters, {size / 1e6:.1f} MB total")
    print("flagged:", json.dumps(flagged))


if __name__ == "__main__":
    main()
