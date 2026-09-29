"""Transport-mode classifier, evaluated on people it never saw.

Features come from the GPS fixes inside each labelled segment (speed profile, stopping,
acceleration, turning). Evaluation is 5-fold cross-validation grouped by DATA SOURCE:
some GeoLife ids are copies of one device's data (see models/core/source_groups.py), so
grouping by user id alone would let a copy of a test trip sit in the training folds.
Labelled segments duplicated across ids in one source are counted once. A median-speed rule is
the baseline to beat. The final model then labels every trip between two stays.
"""
import json
import pathlib

import duckdb
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import accuracy_score, confusion_matrix, f1_score
from sklearn.model_selection import GroupKFold

ROOT = pathlib.Path(__file__).resolve().parents[1]
DB = ROOT / "data/warehouse.duckdb"
OUT = ROOT / "results"
MODES = ["walk", "bike", "bus", "car", "subway", "train"]

FEATURES_SQL = """
with seg as ({segments}),
pts as (
    select s.seg_id, p.ts_utc, p.lat, p.lon
    from seg s
    join stg_points p on p.user_id = s.user_id and p.ts_utc between s.start_utc and s.end_utc
),
steps as (
    select seg_id, ts_utc,
        epoch(ts_utc) - epoch(lag(ts_utc) over w) as dt,
        2 * 6371000 * asin(sqrt(pow(sin(radians(lat - lag(lat) over w) / 2), 2)
            + cos(radians(lag(lat) over w)) * cos(radians(lat))
            * pow(sin(radians(lon - lag(lon) over w) / 2), 2))) as dx,
        degrees(atan2(sin(radians(lon - lag(lon) over w)) * cos(radians(lat)),
            cos(radians(lag(lat) over w)) * sin(radians(lat))
            - sin(radians(lag(lat) over w)) * cos(radians(lat)) * cos(radians(lon - lag(lon) over w)))) as bearing
    from pts
    window w as (partition by seg_id order by ts_utc)
),
v as (
    select seg_id, ts_utc, dt, dx, dx / dt as speed, bearing
    from steps where dt > 0 and dt <= 120
),
v2 as (
    select *, abs(speed - lag(speed) over (partition by seg_id order by ts_utc)) as dspeed,
        abs(((bearing - lag(bearing) over (partition by seg_id order by ts_utc)) + 540) % 360 - 180) as dturn
    from v
)
select seg_id,
    count(*) as n_steps,
    sum(dt) / 60 as minutes,
    sum(dx) / 1000 as km,
    median(speed) as speed_p50,
    quantile_cont(speed, 0.85) as speed_p85,
    quantile_cont(speed, 0.95) as speed_p95,
    avg(speed) as speed_mean,
    stddev(speed) as speed_sd,
    avg((speed < 0.6)::int) as stop_share,
    avg((speed between 0.6 and 2.2)::int) as walkish_share,
    avg(dspeed) as accel_mean,
    quantile_cont(dspeed, 0.9) as accel_p90,
    avg(dturn) filter (where speed > 1) as turn_mean,
    count(*) / nullif(sum(dt) / 60, 0) as fixes_per_min
from v2 group by 1
"""


def features(con, segments_sql):
    return con.execute(FEATURES_SQL.format(segments=segments_sql)).df()


def main():
    OUT.mkdir(exist_ok=True)
    con = duckdb.connect(str(DB))
    labels_sql = """select row_number() over (order by source_group, start_utc, end_utc, mode) as seg_id,
                           user_id, source_group, start_utc, end_utc, mode
                    from (select l.*, g.source_group,
                                 row_number() over (partition by g.source_group, l.start_utc, l.end_utc, l.mode
                                                    order by l.user_id) as copy_no
                          from stg_labels l join source_groups g using (user_id)
                          where l.mode in ('walk','bike','bus','car','subway','train'))
                    where copy_no = 1"""
    lab = con.execute(labels_sql).df()
    f = features(con, labels_sql)
    df = lab.merge(f, on="seg_id")
    df = df[(df.n_steps >= 10) & (df.minutes >= 2)].reset_index(drop=True)
    cols = [c for c in f.columns if c not in ("seg_id", "n_steps")]
    X, y, groups = df[cols].to_numpy(), df["mode"].to_numpy(), df["source_group"].to_numpy()

    pred = np.empty_like(y)
    for tr, te in GroupKFold(n_splits=5).split(X, y, groups):
        m = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.08, random_state=0)
        m.fit(X[tr], y[tr])
        pred[te] = m.predict(X[te])

    def baseline(s):
        return np.where(s < 1.6, "walk", np.where(s < 4.5, "bike", np.where(s < 9, "bus", "car")))
    base = baseline(df.speed_p50.to_numpy())

    report = {
        "segments": int(len(df)),
        "users": int(df.user_id.nunique()),
        "sources": int(df.source_group.nunique()),
        "class_counts": df["mode"].value_counts().reindex(MODES).fillna(0).astype(int).to_dict(),
        "model": {
            "accuracy": round(accuracy_score(y, pred), 3),
            "macro_f1": round(f1_score(y, pred, average="macro"), 3),
            "f1_by_mode": dict(zip(MODES, np.round(f1_score(y, pred, labels=MODES, average=None), 3).tolist())),
        },
        "baseline_median_speed": {
            "accuracy": round(accuracy_score(y, base), 3),
            "macro_f1": round(f1_score(y, base, average="macro", labels=MODES), 3),
        },
        "confusion": {"labels": MODES, "matrix": confusion_matrix(y, pred, labels=MODES).tolist()},
        "method": "HistGradientBoosting on 15 speed/stop/acceleration/turning features; "
                  "5-fold cross-validation grouped by data source (ids that share copied data form one source)",
    }
    (OUT / "modes.json").write_text(json.dumps(report, indent=2))
    print(json.dumps({k: report[k] for k in ("segments", "users", "sources", "model", "baseline_median_speed")}, indent=2))

    # Final model on all labelled data, then label every trip between consecutive stays.
    final = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.08, random_state=0).fit(X, y)
    trips_sql = """
        select row_number() over (order by user_id, leave_utc) as seg_id, user_id, leave_utc as start_utc, next_arrive as end_utc,
               stay_id as from_stay, next_stay as to_stay
        from (select user_id, stay_id, leave_utc,
                     lead(arrive_utc) over (partition by user_id order by arrive_utc) as next_arrive,
                     lead(stay_id) over (partition by user_id order by arrive_utc) as next_stay
              from stays)
        where next_arrive is not null and epoch(next_arrive) - epoch(leave_utc) between 120 and 3 * 3600
    """
    trips = con.execute(trips_sql).df()
    tf = features(con, trips_sql)
    trips = trips.merge(tf, on="seg_id")
    trips = trips[trips.n_steps >= 5].reset_index(drop=True)
    proba = final.predict_proba(trips[cols].to_numpy())
    trips["mode"] = final.classes_[proba.argmax(1)]
    trips["mode_confidence"] = proba.max(1).round(3)
    trips[["seg_id", "user_id", "from_stay", "to_stay", "start_utc", "end_utc", "km", "minutes",
           "speed_p50", "mode", "mode_confidence"]].to_parquet(ROOT / "data/lake/trips.parquet")
    print(f"labelled {len(trips):,} trips between stays:", trips["mode"].value_counts().to_dict())


if __name__ == "__main__":
    main()
