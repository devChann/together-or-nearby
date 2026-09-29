"""Load the raw GeoLife .plt files and transport-mode labels into Parquet.

GeoLife 1.3 (Microsoft Research): 182 users, mostly Beijing, 2007-2012.
Each .plt has 6 header lines, then: lat, lon, 0, altitude (ft), days since 1899-12-30, date, time.
Timestamps are GMT; the pipeline keeps UTC and derives Beijing local time (UTC+8) downstream.
"""
import pathlib
import time

import duckdb

ROOT = pathlib.Path(__file__).resolve().parents[1]
RAW = ROOT / "data/raw/Geolife Trajectories 1.3/Data"
LAKE = ROOT / "data/lake"


def main() -> None:
    LAKE.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    t = time.time()
    con.execute(f"""
        COPY (
            SELECT CAST(regexp_extract(filename, '/Data/([0-9]{{3}})/', 1) AS SMALLINT) AS user_id,
                   regexp_extract(filename, '([0-9]+)\\.plt$', 1)                     AS traj_id,
                   lat, lon, alt_ft,
                   strptime(d || ' ' || t, '%Y-%m-%d %H:%M:%S')                         AS ts_utc
            FROM read_csv('{RAW}/*/Trajectory/*.plt', skip = 6, header = false, filename = true,
                          columns = {{'lat': 'DOUBLE', 'lon': 'DOUBLE', 'zero': 'INTEGER',
                                      'alt_ft': 'DOUBLE', 'days': 'DOUBLE', 'd': 'VARCHAR', 't': 'VARCHAR'}})
        ) TO '{LAKE}/points_raw.parquet' (FORMAT parquet, COMPRESSION zstd)
    """)
    con.execute(f"""
        COPY (
            SELECT CAST(regexp_extract(filename, '/Data/([0-9]{{3}})/', 1) AS SMALLINT) AS user_id,
                   strptime(start_time, '%Y/%m/%d %H:%M:%S')                           AS start_utc,
                   strptime(end_time, '%Y/%m/%d %H:%M:%S')                             AS end_utc,
                   lower(trim(mode))                                                    AS mode
            FROM read_csv('{RAW}/*/labels.txt', delim = '\t', header = true, filename = true,
                          columns = {{'start_time': 'VARCHAR', 'end_time': 'VARCHAR', 'mode': 'VARCHAR'}})
        ) TO '{LAKE}/labels.parquet' (FORMAT parquet)
    """)
    n_pts, n_users, first, last = con.execute(
        f"SELECT count(*), count(DISTINCT user_id), min(ts_utc), max(ts_utc) FROM '{LAKE}/points_raw.parquet'").fetchone()
    n_lab, n_lab_users = con.execute(
        f"SELECT count(*), count(DISTINCT user_id) FROM '{LAKE}/labels.parquet'").fetchone()
    print(f"points: {n_pts:,} from {n_users} users, {first} to {last}")
    print(f"labels: {n_lab:,} segments from {n_lab_users} users")
    print(f"took {time.time() - t:.1f}s")


if __name__ == "__main__":
    main()
