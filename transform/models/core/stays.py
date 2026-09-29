"""Stay detection (Li et al., 2008): a stay is a run of fixes that remain within
`stay_radius_m` of its first fix for at least `stay_min_minutes`. A stay may bridge a
recording gap (GPS drops indoors) up to `stay_max_gap_minutes`, never a longer one.
Consecutive stays at the same spot, separated by a short excursion, are merged.
"""
import numpy as np
import pandas as pd
from numba import njit

R = 6371000.0


@njit(cache=True)
def _hav(lat1, lon1, lat2, lon2):
    p1 = np.radians(lat1)
    p2 = np.radians(lat2)
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(np.radians(lon2 - lon1) / 2) ** 2
    return 2 * R * np.arcsin(np.sqrt(a))


@njit(cache=True)
def _detect(uid, ts, lat, lon, radius, min_s, max_gap):
    n = len(ts)
    si = np.empty(n, np.int64)
    sj = np.empty(n, np.int64)
    k = 0
    i = 0
    while i < n:
        j = i + 1
        while (j < n and uid[j] == uid[i] and ts[j] - ts[j - 1] <= max_gap
               and _hav(lat[i], lon[i], lat[j], lon[j]) <= radius):
            j += 1
        if ts[j - 1] - ts[i] >= min_s:
            si[k] = i
            sj[k] = j - 1
            k += 1
            i = j
        else:
            i += 1
    return si[:k], sj[:k]


@njit(cache=True)
def _centres(si, sj, lat, lon):
    m = len(si)
    clat = np.empty(m)
    clon = np.empty(m)
    rad = np.empty(m)
    for s in range(m):
        a, b = si[s], sj[s] + 1
        clat[s] = lat[a:b].mean()
        clon[s] = lon[a:b].mean()
        d = np.empty(b - a)
        for q in range(a, b):
            d[q - a] = _hav(clat[s], clon[s], lat[q], lon[q])
        rad[s] = np.percentile(d, 90)
    return clat, clon, rad


@njit(cache=True)
def _merge(si, sj, uid, ts, clat, clon, radius, max_excursion):
    m = len(si)
    oi = np.empty(m, np.int64)
    oj = np.empty(m, np.int64)
    k = 0
    for s in range(m):
        if (k > 0 and uid[si[s]] == uid[oj[k - 1]]
                and ts[si[s]] - ts[oj[k - 1]] <= max_excursion
                and _hav(clat[s], clon[s], clat[s - 1], clon[s - 1]) <= radius):
            oj[k - 1] = sj[s]
        else:
            oi[k] = si[s]
            oj[k] = sj[s]
            k += 1
    return oi[:k], oj[:k]


def model(dbt, session):
    dbt.config(materialized="table")
    radius = float(dbt.config.get("stay_radius_m"))
    min_s = int(dbt.config.get("stay_min_minutes")) * 60
    max_gap = int(dbt.config.get("stay_max_gap_minutes")) * 60

    pts = (dbt.ref("stg_points")
           .project("user_id, epoch(ts_utc)::BIGINT AS t, lat, lon")
           .order("user_id, t")
           .fetchnumpy())
    uid = pts["user_id"].astype(np.int64)
    ts = pts["t"].astype(np.int64)
    lat = pts["lat"].astype(np.float64)
    lon = pts["lon"].astype(np.float64)

    si, sj = _detect(uid, ts, lat, lon, radius, min_s, max_gap)
    clat, clon, _ = _centres(si, sj, lat, lon)
    si, sj = _merge(si, sj, uid, ts, clat, clon, radius, 30 * 60)
    clat, clon, rad = _centres(si, sj, lat, lon)

    out = pd.DataFrame({
        "user_id": uid[si].astype(np.int16),
        "arrive_utc": pd.to_datetime(ts[si], unit="s"),
        "leave_utc": pd.to_datetime(ts[sj], unit="s"),
        "lat": clat,
        "lon": clon,
        "radius_m": rad,
        "n_points": (sj - si + 1).astype(np.int32),
    })
    out.insert(0, "stay_id", np.arange(len(out), dtype=np.int64))
    out["minutes"] = (out.leave_utc - out.arrive_utc).dt.total_seconds() / 60
    return out
