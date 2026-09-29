"""Connected components of user ids that share recorded data (at least 100 identical fixes):
ids in one group are treated as a single data source, e.g. for grouped cross-validation."""
import pandas as pd


def model(dbt, session):
    dbt.config(materialized="table")
    users = dbt.ref("int_points_by_user").project("user_id").distinct().df().user_id.tolist()
    edges = dbt.ref("user_overlap").filter("shared_fixes >= 100").project("user_a, user_b").df()
    parent = {u: u for u in users}

    def find(u):
        while parent[u] != u:
            parent[u] = parent[parent[u]]
            u = parent[u]
        return u

    for a, b in edges.itertuples(index=False):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)
    return pd.DataFrame({"user_id": users, "source_group": [find(u) for u in users]})
