"""Group each person's stays into recurring places: DBSCAN over stay centres with a
100 m neighbourhood and no minimum size, so a place is a chain of stays within 100 m."""
import numpy as np
import pandas as pd
from sklearn.cluster import DBSCAN

EPS_M = 100.0


def model(dbt, session):
    dbt.config(materialized="table")
    st = dbt.ref("stays").project("stay_id, user_id, lat, lon").df()
    parts = []
    next_id = 0
    for uid, g in st.groupby("user_id", sort=True):
        xy = np.radians(g[["lat", "lon"]].to_numpy())
        lab = DBSCAN(eps=EPS_M / 6371000.0, min_samples=1, metric="haversine",
                     algorithm="ball_tree").fit_predict(xy)
        parts.append(pd.DataFrame({"stay_id": g.stay_id.to_numpy(), "user_id": uid,
                                   "place_id": lab + next_id}))
        next_id += lab.max() + 1
    return pd.concat(parts, ignore_index=True)
