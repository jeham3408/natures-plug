"""Read the FORCE 2020 LAS files into one parquet table.
    NP_DATA=/path/to/raw uv run --with pandas --with pyarrow --with numpy --with lasio python build_force.py
"""
import glob, os
import pandas as pd, lasio

D = os.environ.get("NP_DATA", "./raw").rstrip("/") + "/"
rows = []
for f in sorted(glob.glob(D + "force2020/las/*/*.las")):
    las = lasio.read(f)
    df = las.df().reset_index()
    df.columns = [c.upper() for c in df.columns]
    df.insert(0, "WELL", str(las.well.WELL.value).strip())
    rows.append(df)
all_ = pd.concat(rows, ignore_index=True)
all_.to_parquet(D + "force2020/all_wells.parquet")
print(all_.WELL.nunique(), "wells,", len(all_), "samples")
