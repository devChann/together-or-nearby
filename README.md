# Together, or just nearby?

Two phones at the same place at the same time don't make two friends hanging out. Colleagues share an office every weekday; strangers share a canteen. This project tells the two apart in real GPS data, and checks itself honestly.

**Live page: [devchann.github.io/together-or-nearby](https://devchann.github.io/together-or-nearby/)** Pick an encounter and watch both people move, meet and leave, next to the evidence behind the verdict.

## Results

On GeoLife (Microsoft Research: 171 people, 22.6 million GPS fixes, Beijing 2007–2012):

| | Encounters judged | Called a meetup or visit |
|---|---:|---:|
| Real pairs | 731 | **41.2%** (95% range 37.7–44.8%) |
| Fake pairs, 5-week shift (used to design the rules) | 280 | 3.6% (2.0–6.4%) |
| Fake pairs, 9-week shift (held back, scored once) | 240 | **1.7%** (0.6–4.2%) |

The detector never sees the clock, yet what it calls **routine** is 86% weekday 09:00–17:00 and 2% weekend, while **meetups** are 29% weekend with a median of 37 minutes.

## How it decides

For every time two people's stays overlap (centres within 150 m, at least 10 minutes), three questions:

1. **Is either of them usually here at this time?** On other days of the same kind (weekday or weekend) within six weeks, *counting only days the phone was recording then*, how often was each person at this spot at this time of day? Both usually here means routine.
2. **Did they arrive and leave together?** Strangers on independent schedules rarely leave within minutes of each other. Among encounters where both people were somewhere unusual, real pairs left within 10 minutes of each other 77% of the time; fake pairs 13%.
3. **Is the spot usually busy at this hour?** Measured with H3 cells over everyone else's stays on comparable days.

A home visit breaks the timing pattern (the host stays after the guest leaves), so visits are judged by how private the spot is instead.

**Calibration without labels.** Nobody labelled which GeoLife encounters were meetups. Shifting one person of every pair by whole weeks keeps each weekly routine but breaks any arrangement to meet, so every encounter between such fake pairs is coincidence by construction. The rules were designed against a 5-week shift and reported once against a 9-week shift, the way a holdout should be used.

## The result that was too good

The first version called **65%** of real encounters meetups, and its best examples were too perfect: arrivals and departures to the minute, identical trips. **1.55 million GPS fixes** turned out to be copies, the same second and the same six-decimal coordinates filed under a second id. Two receivers never agree that exactly. Fifteen groups of ids share copied data; one has 19 ids.

The fix is at the source (`stg_points`): each copied fix is kept once, under the id that recorded the most data. Real encounters fell from 2,311 to 920. Encounters between ids that share copied data are excluded, since they may be one person. The same leak had inflated the transport-mode score: split by person it read 81.2%; split by data source it is 77.2%.

## Transport mode

Gradient boosting on 15 per-trip features (speed profile, stopping, acceleration, turning), 5-fold cross-validation with each data source entirely in training or entirely in test: **77.2% accuracy, macro F1 0.70**, against 61.7% for a median-speed rule. Walking and cycling score above 0.90 F1; car against bus is the hard pair, as in published work on this dataset.

## Pipeline

```
raw .plt files ──DuckDB──▶ Parquet ──dbt──▶ warehouse.duckdb ──▶ docs/data/*.json ──▶ docs/ (static page)
```

| dbt model | What it does |
|---|---|
| `int_points_by_user`, `stg_points` | Clean fixes (impossible coordinates, >250 km/h spikes), then keep each copied fix once |
| `stays` (Python, numba) | Li et al. stay points: 200 m, 20 min, bridging indoor GPS gaps up to 6 h |
| `stay_place` (Python), `places` | DBSCAN places per person; home and work by time of day |
| `encounters` | DuckDB range join over stays; the same join with one side shifted builds the fake pairs |
| `routine_days`, `encounter_routine` | Per person and comparable day: recording? here at this time? |
| `encounter_context` | Busyness now and usually (H3), arrive and leave gaps |
| `shared_fixes`, `user_overlap`, `source_groups`, `encounter_duplicates` | Copied-data detection |
| `encounter_labels`, `calibration` | Labels and the real-versus-fake table |

16 models, 8 data tests. `analysis/modes.py` trains the transport-mode model; `pipeline/export.py` applies the privacy filter and writes the page's data.

## Privacy

Homes are inferred only to hide them: every GPS fix within 300 m of any detected home is removed before anything is published, and encounters near a home appear only as an H3 hexagon of about 0.7 km². Ids are GeoLife's own anonymous numbers. In a product, the routine test needs only per-day presence at a place, not raw tracks, so it could run on aggregates or on the device.

## Limits

- GeoLife is mostly researchers and students in one Beijing district, 2007–2012. Phones sample differently today.
- A stay needs 20 minutes in one place: a quick coffee together is invisible, and so is walking together.
- There is no ground truth for meetups. The evidence is the false-alarm rate on fake pairs and the time-of-week pattern.
- Thresholds (usually here: 50% of comparable days; rarely: under 25%; 10-minute gaps; 150 m) were chosen by reasoning and checked on the design set only.

## Run it

```bash
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
# GeoLife Trajectories 1.3 from Microsoft Research, unzipped into data/raw/
curl -L -o data/raw/geolife.zip "https://download.microsoft.com/download/F/4/8/F4894AA5-FDBC-481E-9285-D5F8C4C4F039/Geolife%20Trajectories%201.3.zip"
(cd data/raw && unzip -q geolife.zip)
./run.sh
python3 -m http.server --directory docs 8123
```

## Credits

GeoLife GPS Trajectories 1.3, Microsoft Research Asia (Zheng, Xie, Ma and others, 2008–2010), used for non-commercial research. Stay-point detection after Li et al. (2008). Base map © OpenStreetMap contributors, tiles by OpenFreeMap.
