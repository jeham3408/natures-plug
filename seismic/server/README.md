# Seismic viewer

> **Inside Nature's Plug.** This copy lives in `seismic/server/`; the page itself (index.html, app.js, style.css) is one folder up, in `seismic/`, and by default the server serves the whole Nature's Plug app. Start everything with `./start.sh` from the app root. Where this README says `web/` or `open.sh`, read `seismic/` and `start.sh`.

A small interactive viewer for one 3D seismic cube: inline section, crossline
section and time slice side by side, with band-pass filtering, RMS amplitude and
a few other attributes computed on request.

![Viewer on the Adele cube](docs/adele-default.png)

Built at the FORCE hackathon 2026 on the open **Adele 3D** cube (NW Australia).
Only open data is used.

## Open it

The server runs on the Linux PC, where the cube is. From the Mac:

```bash
./open.sh
```

Then open <http://127.0.0.1:8777/>. `Ctrl-C` stops both the tunnel and the server.

- `./open.sh synthetic` shows the synthetic test cube instead.
- `PORT=8780 ./open.sh` uses another port.
- `SV_HOST`, `SV_REMOTE_DIR` and `SV_REMOTE_PY` override the ssh host, the
  folder and the Python interpreter on the remote machine.

Directly on the machine that has the data:

```bash
python server.py --data data/adele --port 8777
```

The server listens on `127.0.0.1` only. From another machine, reach it through
an ssh port forward (`ssh -t -L 8777:127.0.0.1:8777 host ...`), which is what
`open.sh` does.

Needs Python with `numpy`, `scipy` and `Pillow` (tested with Python 3.12). The page is plain
HTML/JS with no external libraries.

## What you can do

| Control | Effect |
|---|---|
| Inline / crossline / time sliders, number fields, ‹ › | Move the cross-hair; all three panels follow |
| Click or drag in a panel | Move the cross-hair to that point |
| Shift-drag in a panel | Zoom; double-click or *Reset zoom* for full extent |
| Attribute | Amplitude, RMS amplitude, envelope, instantaneous frequency, spectral decomposition |
| Band-pass | Low/high corner in Hz, presets 5–15, 15–30, 30–60 Hz |
| RMS window length | Sliding window in ms; the map becomes an RMS map over that window |
| Colour map, polarity, gain | Display only, no new request |

The amplitude-spectrum chart shows the mean spectrum of the displayed inline
window, raw and filtered. The whole state is kept in the URL (`#il=...&xl=...`),
so a view can be bookmarked or shared.

The map is drawn north up and east right with true aspect ratio, a north arrow
and a scale bar. For Adele, crossline numbers increase to the **west**, so they
decrease from left to right on the map.

## Prepare a cube

`prep.py` converts a SEG-Y file to two memory-mapped float32 arrays (one ordered
for sections, one for time slices) and a `meta.json`:

```bash
python prep.py /path/to/Adele_blind_cube_fault_detection.segy \
    --expect-bytes 3488703164 --md5 a35205394470b5bd32a218594bffbe8c
```

It reads every trace header and refuses the file unless inlines, crosslines and
coordinates form a regular grid. Output goes to `data/adele/` (about 6.6 GB for
Adele, 45 s). Byte positions for inline, crossline, X and Y can be set with
`--il-byte`, `--xl-byte`, `--x-byte`, `--y-byte` (defaults 189, 193, 181, 185).
Only IEEE float SEG-Y (format code 5) is supported.

A synthetic cube with a known answer (dipping layers, a fault, a channel, an
asymmetric letter F in map view) is made with:

```bash
python make_synthetic.py
```

## How the numbers are computed

- **Band-pass:** zero-phase FIR (Hamming window), 31 to 201 taps. Each panel
  title gives the number of taps and the slope width. With a low corner below
  about 2 Hz the 201-tap limit means 0 Hz is not fully removed; the page says so.
- **RMS amplitude:** square root of the mean of squares in a centred sliding
  window. The window is rounded to an odd number of samples (200 ms becomes
  204 ms at 4 ms sampling); the title shows the window really used.
- **Envelope:** magnitude of the analytic trace.
- **Instantaneous frequency:** time derivative of the phase of the analytic
  trace, in Hz. It is noisy where the envelope is small.
- **Spectral decomposition:** magnitude after convolution with a complex Gabor
  kernel at the chosen frequency (5–100 Hz). This is a **band**, about ±31 % of
  the centre frequency at −6 dB, not a single frequency; the title gives the band.
- **Colour scale:** one fixed scale per setting for the whole cube (from a
  fixed sample of 2000 traces), so panels, lines and times can be compared.
- **Edges:** traces are zero-padded, so the first and last part of a filtered
  trace is affected. The striped margins on the sections mark that zone.
- **Read-out:** images travel as 8-bit JPEG. The hover value is therefore
  approximate (about ±2 % of the colour scale, more next to very strong events).
- When a panel has fewer pixel rows than time samples, the image is averaged
  for display and a note in the plot says so. Zoom in to see every sample.

## Tests

```bash
python -m pytest -q tests
```

167 tests cover the signal processing against analytic answers, the HTTP API on
a synthetic cube, and robustness (dropped connections, bad parameters). The
page's helper functions are tested through `tests/check_app.js` when `node` is
installed. Interaction in the page is **not** tested automatically.

## Data

Adele 3D seismic survey, PSTM full offset, as used in the FORCE 2020 machine
learning competition for fault identification.

- **Data courtesy of Geoscience Australia.** Licence CC BY 4.0.
- DOI [10.5281/zenodo.4299758](https://doi.org/10.5281/zenodo.4299758)
- 301 inlines (4175–4775, step 2) × 2731 crosslines (5670–8400) × 1001 samples,
  4 ms, 1500–5500 ms two-way time. Bin 12.5 m × 37.5 m, about 34 km × 11 km.
  CRS GDA94 / MGA zone 51.
- The last 8 crosslines (8393–8400) are empty on every inline.
- One trace (inline 4585, crossline 6071) has a noise burst at 5172–5212 ms,
  about 200 times the normal amplitude. Filters ring on it.

The cube is not part of this repository (`data/` is ignored).

## Known limits

- Tested in Chrome only. Firefox, Safari and touch screens are not tested.
- One cube at a time, time slices only (no horizon slices, no arbitrary lines).
- The first filtered view after start takes a few seconds (measured 3.9 s on
  Adele); a filtered time slice in a part of the cube that is
  not in the disk cache takes 2–5 s. Everything else answers in well under a
  second.
- If the ssh session is lost without `Ctrl-C`, the server can keep its port for
  up to about 30 s before it stops by itself.
