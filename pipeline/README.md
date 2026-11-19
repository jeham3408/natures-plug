# Data pipeline

Builds `../data/` from open raw data. The app does all screening itself; these scripts only prepare its inputs.

You need Python 3.11 or newer with [uv](https://docs.astral.sh/uv/) (or install pandas, pyarrow, numpy, lasio and shapely yourself), about 15 GB of free disk and half an hour.

```bash
export NP_DATA=/path/to/raw        # where the raw downloads go

./download.sh                      # about 6 GB: FORCE 2020 logs, FactPages tables, Diskos report texts, map geometry
uv run --with pandas --with pyarrow --with numpy --with lasio python build_force.py
python3 index_diskos.py            # about 16 minutes: SQLite full-text index and keyword hits
uv run --with pandas python docs_evidence.py
uv run --with pandas --with pyarrow --with numpy --with shapely python export_app.py ../data
```

| Step | Reads | Writes |
|---|---|---|
| `download.sh` | Zenodo, FactPages, FactMaps, Natural Earth | `force2020/`, `factpages/`, `diskos/`, `geo/` |
| `build_force.py` | 118 LAS files | `force2020/all_wells.parquet` |
| `index_diskos.py` | `diskos/Norway_Diskos_reports.csv` (2.75 million pages) | `diskos/diskos.sqlite`, `creep_hits.csv`, `pa_hits.csv`, `diskos_files.csv` |
| `docs_evidence.py` | keyword hits, formation tops | `derived/doc_hits.csv`, `derived/doc_hits_rate_by_group.json` |
| `export_app.py` | all of the above | `../data/` |

## What the export contains

| File | Content |
|---|---|
| `wellbores.json` | 2,893 development wellbores that are not permanently plugged, column by column |
| `controls.json` | 117 wells with logs: 1 m medians of gamma ray, deep resistivity and sonic down to the deepest hydrocarbon zone, true vertical depth, group tops, hydrocarbon zones with mud weight, leak-off tests |
| `layer1.json` | 2,050 exploration wells with group tops, leak-off tests and hydrocarbon zones, for the formation-level screen |
| `fields.json`, `geo.json` | Field outlines, land, quadrants, CO₂ storage licences |
| `wells/<well>.json` | Full curves, formation tops, casing, mud and report quotes for one log well, loaded when it is opened |
| `docs/<wellbore>.json` | Report quotes for one wellbore or exploration well, loaded when it is opened |
| `validation.json`, `meta.json` | Fields with documented use, keyword rates by group, defaults, sources |

Depths are metres measured depth from the rotary table. True vertical depth comes from the `Z_LOC` curve in the FORCE logs and the kelly bushing elevation in FactPages. Pressures are equivalent mud weights in g/cm³.

## Searching the reports

`index_diskos.py` leaves a SQLite database with full-text search over every report page:

```bash
python3 query_diskos.py '"creeping shale"' --limit 5
python3 query_diskos.py 'cement AND plug* AND abandon*' --type DEVELOPMENT --limit 20
python3 query_diskos.py --well 31/4-5 --item COMPLETION_REPORT --limit 5 --full
```

This is the place to start for the next step: reading measured formation pressures, cement tops and mud types out of the reports.

## Green Clay predictor

Three more scripts in `greenclay/` build `../data/greenclay.json` from the same raw downloads. They need the report index from `index_diskos.py`.

```bash
mkdir -p $NP_DATA/greenclay && cp greenclay/*.py $NP_DATA/greenclay/
python3 $NP_DATA/greenclay/extract_picks.py     # every mention of the Green Clay, with the numbers beside it
python3 $NP_DATA/greenclay/build_picks.py       # one top per wellbore where a report gives a true vertical depth
NP_APP=$(cd .. && pwd)/ uv run --with numpy python $NP_DATA/greenclay/build_greenclay.py
```

`greenclay/gc_picks.csv` is the answer key as built on 19 November 2026: wellbore, depth, report file, page and the text around the name.

## Documented barrier cases

`barrier/find_candidates.py` pulls the report passages that may describe clay or collapsed formation as an annular barrier. They were read once and classified by hand into `barrier/barrier_cases.csv` (15 wells on 19 November 2026). `barrier/build_barrier.py` attaches the report file and the position and writes `../data/barrier.json`; `node tools/barrier.mjs` then adds what the atlas and the Green Clay model say at each well.
