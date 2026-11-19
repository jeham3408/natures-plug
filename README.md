# Nature's Plug

An open atlas of where the overburden clay on the Norwegian continental shelf can seal a well by itself, and where it cannot.

![Nature's Plug: map of wellbores left to plug and the log panel for well 35/11-7](docs/screenshot.jpg)

About 2,900 wellbores on the Norwegian shelf are not yet permanently plugged, and plugging is more than half the cost of shutting a field down. Some clays above the reservoir creep in around the casing and close the annulus without cement. Operators have used this as a well barrier element since 2006, but there is no open map of where it can work.

Nature's Plug screens open data for it: well logs from 117 wells, leak-off tests and formation tops from FactPages, and 2.75 million pages of well reports from Diskos. **It ranks where to look. It does not verify a barrier.**

## Run it

No build step and no dependencies. Serve the folder and open it. It is one app on one page: the map and the seismic share the middle of the page, the panel on the right always describes the selected well, and a well chosen anywhere is the same well everywhere.

```bash
python3 -m http.server 8000
```

Then go to <http://localhost:8000>. It works offline. The folder can also be published as it is on GitHub Pages.

The seismic part also needs its Python back end and the seismic cubes, which sit on a separate Linux machine and are not in this repository. `./start.sh` starts the back end there and forwards it; the app is then at <http://127.0.0.1:8777>. `./start.sh local` is the same as the command above. Without the back end everything works except the seismic, and the seismic stage says what is missing.

## What you can do

- **Map.** Every wellbore left to plug, coloured by what the nearest assessed well says. Click a field, a wellbore or a well. The outlines of the open seismic cubes are on the map; click one to open it.
- **Three levels on the same map.** Log level uses the wells with open logs. Formation level runs the same pressure test on 729 exploration wells using formation tops only. Green Clay colours every well by the predicted depth to the top of the Green Clay and marks the report sites it was learned from.
- **Map, seismic or both.** The switch in the top bar puts the seismic sections and the 3D view where the map is, or both above each other. The selected well stays selected.
- **One panel for the selected well.** Screening verdict, logs, the predicted Green Clay interval and report quotes; and for the wells inside a seismic cube a second tab, **On seismic**, with the well tie, the followed events and the thickness map.
- **Well panel.** Gamma ray, resistivity, sonic, density and caliper against depth, the clay signature, and the pressure the barrier must hold against what the leak-off tests give. Scroll to zoom the depth.
- **Report quotes.** Keyword matches from the well's own reports, with file and page. Click a quote to find its depth in the logs.
- **Assumptions.** Every threshold is a slider and the map is recalculated at once. Each well takes a measured pore pressure.
- **Validation.** Does the screen find the fields where the method is already in use?
- **Tour.** A six-step walk-through for a four-minute demo. Arrow keys move between steps.
- **Links.** `#well=35/11-7`, `#wellbore=7/12-A-7 D`, `#field=TROLL` open a selection directly.

## How the screen works

1. **Rock.** A 1 m sample has the clay signature when deep resistivity is below 1.3 Ω·m, gamma ray is above 40 API and sonic is slower than 135 µs/ft. It counts in any group above the reservoir.
2. **Pressure.** At that depth the leak-off tests must give more than the reservoir pressure with a gas column up to it (Williams et al., SPE/IADC 119321, 2009). Pore pressure is the mud weight at the top of the shallowest named hydrocarbon zone, minus 0.05 g/cm³.
3. **Length.** Rock and pressure must hold together over at least 30 m along the hole.
4. **Reach.** A wellbore that is left to plug inherits the result of the nearest assessed well within 10 km.

All of it lives in [`js/engine.js`](js/engine.js), about 280 lines with no DOM code, and is covered by [`tests/engine.test.mjs`](tests/engine.test.mjs).

## Numbers with the default assumptions

Print them with `npm run summary`.

| | Wellbores left to plug |
|---|---:|
| Total (FactPages, 17 November 2026) | 2,893 |
| Near a log well that passes | 663 |
| Near a log well that fails | 625 |
| No assessed log well within 10 km | 1,605 |
| Formation level: clay group inside the pressure window | 1,631 |
| Formation level: less than 50 m in the window | 77 |
| Formation level: clay group above the window | 1,007 |
| Formation level: no assessed well within 10 km | 178 |

52 of the 117 log wells can be assessed; 21 pass, 20 of them on an interval in the Hordaland or Rogaland Group and one, 35/11-15 S, on an interval in the Shetland Group. Counting only the two clay groups would give 652 wellbores instead of 663. 16 fields have at least one wellbore near a passing well, among them Troll, Grane, Johan Sverdrup, Balder and Brage. Gullfaks, Snorre and Visund fail: the clay is there, but it lies above the depth where the pressure holds.

## Green Clay predictor

Built during the hackathon, on 19 November 2026. It is the **Green Clay** level of the map; every well card shows the predicted interval, and **How it was made and tested** in the legend opens the evidence: the charts, the answer key and the documented cases.

Operators on Troll, Oseberg, Brage and Visund call a swelling Eocene clay in the Hordaland Group the Green Clay, and they write its depth in their drilling and completion reports. The predictor uses those sentences as an answer key.

1. A search through the 2.75 million report pages finds 2,098 mentions of the Green Clay in 485 wellbores.
2. Where a report gives the top as a true vertical depth, the number is kept with its file, page and quote: 89 wellbores, which share 29 sites in 7 fields.
3. Each site is compared with the Hordaland and Rogaland Group tops in the nearest vertical exploration well (FactPages).
4. One line is fitted: the Green Clay reaches down to the Rogaland top, and its thickness is 194 m plus 0.14 times the thickness of the Hordaland Group, kept within the 141 to 430 m the sites cover.

| Way to predict the top | Average miss, whole field left out |
|---|---|
| This model | 55 m |
| Copy the thickness from the nearest known site | 72 m |
| Fixed height above the Rogaland top (310 m) | 75 m |
| Plain guess: the middle of the Hordaland Group | 123 m |

Nine in ten held-out sites fall within 106 m. In 100 of 103 log wells the predicted interval has lower resistivity than the same thickness above it, which fits a water-rich clay but does not prove it. Of the 2,893 wellbores left to plug, 844 lie within 10 km of a wellbore whose report names the Green Clay, 1,957 get a prediction from the model alone and 92 have no reference well within 10 km.

What to keep in mind: the answer key is small and all of it is in the northern North Sea. The depths were read by pattern from scanned text; the quote behind every site was read once and two errors were removed, but nobody has checked them against the original pages, and a few are planned depths. The base is assumed to be the Rogaland top. Outside the seven fields the model is untested.

Rebuild it with the three scripts in [`pipeline/greenclay/`](pipeline/greenclay/); `gc_picks.csv` there is the answer key.

### Where clay was used as a barrier, and where it did not hold

The same page lists 15 wells from the public reports, read by hand from a keyword search (`pipeline/barrier/`): 7 where clay was used as a barrier or confirmed on a log, 2 where it did not hold and 6 where it was planned and the result is not public. Five of them name the Green Clay. It is reported as a barrier element on Veslefrikk (30/3-A-20 A) and confirmed on a log on Brage (31/4-A-32 A). On Visund (34/8-A-2 H), 792 m of it behind uncemented casing was assumed to have closed in after two years, and total mud losses showed that it had not.

Against these cases the atlas is cautious. For both wells where the clay did not hold it says fail and absent. Of the 7 where it held, the log level has a verdict for 5 and says pass for 1, and the formation level has a verdict for 6 and says present for 2. One reason is that the atlas tests the clay against the pressure of the main reservoir, while several of these wells used it against a shallower zone or used the Shetland Group. The list is short and skewed: plugging reports are rare in the open archive.

## What it has been checked against

Open data has no bond logs, so the screen cannot be compared with verified barriers. Three weaker checks are possible:

- **Fields with documented use.** Havtil's 2025 knowledge report names five fields with wells left where creeping shale is used: Ekofisk, Valhall, Ula, Ivar Aasen and Balder. At formation level all five come out with the clay group inside the pressure window (Valhall for 72 of 105 wellbores, the others for all). The screen was not told which fields they are.
- **The two levels against each other.** Of the wells that have both, 20 of 21 that pass on logs are also flagged by formation tops. So are 8 of the 31 that fail, which is why the logs are needed.
- **The reports.** Clay-specific terms (gumbo, swelling, plastic or mobile clay, creep) are about twice as frequent per kilometre drilled in the Nordland, Hordaland and Rogaland groups as in deeper groups. Plain tight-hole and overpull mentions do not single those groups out.

## Seismic and 3D: wells on seismic

Built during the hackathon, on 19 November 2026. It is the **Seismic and 3D** side of the stage (the switch in the top bar, **On seismic** in a well card, or a click on a cube outline on the map). Choosing a well anywhere moves the seismic to it, and to its cube if another one is shown. It shows a 3D seismic cube as an inline, a crossline and a time slice, linked by cross-hairs, with band-pass filtering, an amplitude spectrum, RMS amplitude, envelope, instantaneous frequency and simple spectral decomposition. The work is done by the back end in [`seismic/server/`](seismic/server/README.md) (numpy and scipy).

- **3D view.** The three sections as planes in one scene, with the wells, their tops and the followed events as surfaces. Drag to turn, wheel to zoom, click a plane to move the cross-hair. Plain WebGL, no library.
- **Logs and tops on the sections.** Gamma ray, sonic velocity, impedance, resistivity or density along the well, the group tops from FactPages and the top of the Green Clay from the predictor, all in two-way time.
- **Well tie.** A synthetic seismogram from sonic and density beside the seismic trace at the well. Wavelet (Ricker, or one with the spectrum of the seismic), phase, polarity, bulk shift and the window the tie is judged in can all be changed, and a track shows the correlation in a sliding 200 ms window, so it is visible where the tie holds.
- **Follow the clay away from the well.** One press follows the event at a top through the whole cube. Two followed events give a thickness map, and each followed event is compared with the same top in the other wells.
- **Logs predicted from seismic.** P velocity, impedance and gamma ray as colour on the inline through a well, with a blind test at every well (see below for how well it works).

The cubes are TNE01 (Troll East) and GN1101 (Smeaheia) from the Smeaheia dataset of Gassnova and Equinor, and the 1994 baseline survey of Sleipner (full stack, 94p07) from the Sleipner 4D dataset of the Sleipner Group. Atlas wells inside them: 31/3-3 and 31/3-4 in TNE01, 32/2-1 and 32/4-1 in GN1101, 15/9-13 at Sleipner.

**The one well with a measured time-depth relation.** 15/9-13 comes with a checkshot-corrected sonic log (curve DT-CKS of the Sleipner reference dataset) from sea level to 2000 m. Integrated as it is, with nothing picked or fitted, it puts the sea bed at 109 ms where the seismic shows it at 110 ms. The best bulk shift over the whole log is 0 ms, with normal polarity. The correlation is 0.56 between 800 and 1300 ms, across the Utsira Formation and the top of the Hordaland Group at 1176 ms, 0.29 over the whole log, and 0.12 inside the Hordaland clay below (1116 to 1988 ms). So with the time-depth relation right, the top of the clay ties and the inside of the clay does not: it has little reflectivity of its own to tie to.

**How the time-depth relation is built for the other four wells.** No measured checkshot table is open for them. The sea bed is picked on the seismic, the sonic log is integrated below it, and the unlogged interval between the sea bed and the first usable sonic sample gets one velocity. For 32/2-1 and 32/4-1 that velocity is the one that makes the curve pass through four depth-time picks per well from the dataset's feasibility study (1884 and 1599 m/s). The TNE01 wells have no such picks and use the 32/2-1 value. Sonic that records the steel casing (about 57 us/ft) is removed: in 32/4-1 that is the log down to 727 m. The "OWT" curve delivered with the 32/2-1 logs is not used; it gives the sediments above the first sonic sample the velocity of water and is about 50 ms late below them.

**Where the ties stand** (Ricker 25 Hz, the bulk shift between -40 and +40 ms that correlates best in the tie window, which is the clay interval where the well has one):

| Well | Time-depth | Tie window | Shift | Correlation in the window | Without the shift |
|---|---|---|---|---|---|
| 15/9-13 | checkshot-corrected sonic | 800 to 1300 ms (set by hand) | none | 0.56 | 0.56 |
| 32/2-1 | tied to picks | 582 to 1254 ms (whole log) | +10 ms | 0.54 | -0.16 |
| 32/4-1 | tied to picks | 631 to 1067 ms | +18 ms | 0.64 | -0.50 |
| 31/3-3 | not calibrated | 592 to 1011 ms | +20 ms | 0.37 | -0.22 |
| 31/3-4 | not calibrated | 1169 to 1578 ms | +32 ms | 0.50 | -0.06 |

What to keep in mind:

- **The four fitted shifts are all positive**, 10 to 32 ms, while the well with a measured time-depth relation needs none. One reading is that the four curves are still too fast between the sea bed and the first sonic sample; another is a wavelet that is not zero phase in those two surveys. Neither has been shown.
- **A shift chosen by correlation can sit on the wrong cycle.** The correlation is negative without the shift for every well, so a polarity reversal at no shift scores almost as well. The panel shows both numbers.
- **One independent check exists and it is not good.** The dataset's own Top Shetland horizon is at 968 ms at 32/4-1; the tied time-depth curve puts that top at 989 ms before the shift.
- **Over a whole log the correlation is low** (0.10 to 0.54), because the misfit drifts with depth where nothing calibrates it. The ties hold over a few hundred milliseconds, not over a well.
- **Density is partly estimated from sonic** (Gardner) and marked in the panel.
- **The follower is a plain autotracker.** It can jump a cycle across faults and unconformities, and its result depends on which cycle the seed lands on: the top of the Rogaland Group followed from 31/3-3 came out 8 ms above the same top in 31/3-4 with the first time-depth curves, and 30 ms below it with the present ones; the Shetland top comes out 39 ms above. Two blind checks in one cube, both within a cycle or two, neither a hit. Its lines are a guide to check on the sections, not an interpretation.
- **A strong continuous event is not necessarily the clay.** A published study of the Troll area maps a silica-diagenesis reflector inside the Hordaland Group (Wrona et al. 2017).
- No report-quoted Green Clay depth lies inside either cube, so the Green Clay line is the predictor's estimate, not an observation.
- At 31/3-4 FactPages lists no Hordaland Group but 444 m with "no formal name" under the Utsira Formation. The event followed from the Hordaland top in 31/3-3 continues to that well. Whether it is the same clay has not been checked.

### Logs predicted from seismic, and how well that works

`seismic/server/predict_logs.py` predicts P velocity, acoustic impedance and gamma ray away from the wells, and the app draws the result as colour on the inline through a well (**Predicted from seismic** in the side panel) and as a blind curve beside the log in the well-tie panel. The inline is turned into features on a grid of 16 ms by 16 traces, the logs smoothed to 32 ms are the answer key at the well trace, and a ridge regression connects the two. Three sets of features are compared: two-way time below the sea bed alone (the compaction trend, no seismic), time plus classic attributes (relative impedance, envelope, RMS amplitude, instantaneous frequency), and time plus the patch embeddings of the NCS seismic foundation model ([Ordoñez et al. 2026](https://arxiv.org/abs/2603.23211); `NorskRegnesentralSTI/NCS-v1-2d-base`, Apache-2.0, frozen and not fine-tuned, 12 principal components).

The test is leave-one-well-out over the five wells: the model never sees the well it is scored on. Mean over the five wells, with the full table in [`data/log_prediction.json`](data/log_prediction.json):

| Property | Time trend only | + classic attributes | + NCS embeddings |
|---|---|---|---|
| P velocity: correlation, error | 0.87, 696 m/s | 0.76, 713 m/s | 0.73, 706 m/s |
| Acoustic impedance: correlation, error | 0.83, 2096 | 0.67, 2137 | 0.65, 2119 |
| Gamma ray: correlation, error | -0.25, 31.7 API | -0.04, 32.0 API | 0.20, 32.3 API |

What that says:

- **For velocity and impedance the seismic adds nothing here.** The depth trend alone does as well or better. Neither feature set lowers the mean error.
- **For gamma ray nothing predicts well.** The NCS embeddings carry a weak signal: of what the trend misses, their part correlates 0.41 on average (0.01 to 0.73 over the wells; 0.30 for the classic attributes), but the error does not go down.
- **Five wells in three areas is very little to learn from.** One of them is 300 km from the other four, the logs are of different vintages, gamma ray is not calibrated between them, and four of the five are placed in time by a fitted shift.
- **The grid is coarse**: nothing finer than about 30 ms can come out, so thin beds are out of reach.
- Shear velocity, ductility and smectite content are not predicted: there are no open measurements of them in these wells to learn from.

So the tool is there, and with the open data it does not yet predict logs better than a depth trend. That is a result about the data, not a tuned model: nothing was fitted to make the table look better.

Rebuild: `seismic/server/prep.py` converts a SEG-Y cube, `seismic/server/prep_wells.py` places the wells and writes `wells.json` beside the cube and `data/seismic_wells.json` for the atlas.

## What it does not do

- It does not verify a barrier. That takes bond logs and a pressure test of the annulus.
- Mud weight overstates pore pressure. Measured formation pressures are in the well reports and should replace it.
- The thresholds are not calibrated against laboratory or field data.
- A wellbore is judged by a neighbouring exploration well, not by its own logs.
- Logs are resampled to 1 m. At the original 0.15 m sampling with strict continuity, 651 wellbores pass instead of 663. The headline is stable; the split between 30 m and 50 m intervals is not.
- Report quotes are keyword matches in scanned text. They are leads to read, not findings.

## Data and licences

| Source | Used for | Licence |
|---|---|---|
| [FORCE 2020 well log and lithofacies dataset](https://zenodo.org/records/4351156) | Well logs; 117 of its 118 wells are used | CC BY 4.0 |
| [FactPages and FactMaps](https://factpages.sodir.no/), Norwegian Offshore Directorate | Wellbores, tops, leak-off tests, mud, field outlines, quadrants | NLOD 2.0 |
| [Diskos report texts](https://zenodo.org/records/10775273), FORCE | Report quotes | CC BY 4.0 |
| [Smeaheia dataset](https://co2datashare.org/dataset/smeaheia-dataset), Gassnova SF and Equinor ASA, CO2 DataShare, doi 10.11582/2021.00012 | Seismic cubes TNE01 and GN1101, logs and time-depth of 32/2-1 and 32/4-1 | [Smeaheia Dataset Licence](https://co2datashare.org/smeaheia-dataset/static/SMEAHEIA%20DATASET%20LICENSE_Gassnova%20and%20Equinor.pdf) (based on CC BY 4.0; may not be sold). Not redistributed here |
| [Sleipner 4D Seismic Dataset](https://co2datashare.org/dataset/sleipner-4d-seismic-dataset) (doi 10.11582/2020.00005) and [Sleipner 2019 Benchmark Model](https://co2datashare.org/dataset/sleipner-2019-benchmark-model) (doi 10.11582/2020.00004), the Sleipner Group, CO2 DataShare | Seismic cube 94p07 (1994 baseline, full stack), logs of 15/9-13 | [Sleipner CO2 Reference Dataset Licence](https://co2datashare.org/sleipner-2019-benchmark-model/static/license.pdf) (based on CC BY 4.0; may not be sold). Not redistributed here |
| [NCS seismic foundation model](https://github.com/NorskRegnesentral/NCS_models), Norwegian Computing Center (Ordoñez et al. 2026, arXiv:2603.23211) | Features for the log prediction | Apache-2.0. Not redistributed here |
| [Natural Earth](https://www.naturalearthdata.com/) | Land polygons | Public domain |
| Havtil / Reflekt AS, knowledge report on creeping shale as a well barrier element, 25 November 2025 | Fields with documented use | Cited |

The files under `data/` are derived from these sources and keep their licences. The code is MIT licensed.

## Repository layout

```
index.html, css/, js/     the app: one page (vanilla JavaScript modules, canvas map, SVG log tracks)
js/engine.js              the screening logic
js/workspace.js           map and seismic on one stage, one selected well, the tabs of the right panel
js/greenclay.js           the Green Clay level: map colours, well cards and the evidence sheet
data/                     static JSON the app loads (53 MB, most of it loaded on demand)
pipeline/                 scripts that build data/ from the raw downloads
seismic/                  the seismic part of the page (app.js sections, wells.js wells and tie, view3d.js) and seismic/server/, its Python back end (built during the hackathon)
start.sh                  starts the whole app, including the seismic back end on the Linux machine
tests/, tools/            engine and data tests and a command-line summary (Node 20 or newer)
talk/                     the four-minute presentation: eleven slides over a 3D scene, see talk/README.md
```

## Rebuild the data

See [`pipeline/README.md`](pipeline/README.md). In short: download about 6 GB of open data, index the report texts, export. The export is deterministic; running it again gives byte-identical files apart from the build time.

## Tests

```bash
npm test
```

The seismic back end has its own tests (Python 3 with numpy, scipy, Pillow and pytest): `cd seismic/server && python -m pytest -q`.

## What was prepared before the hackathon

The data pipeline, this first version of the app and the slides in [`talk/`](talk/README.md) were prepared on 17 and 18 November 2026, before the FORCE VibeCode Hackathon in Stavanger began, with AI coding assistance (Claude Code). The Green Clay level, the seismic and 3D part and the single-page workspace that holds everything together were built during the hackathon, on 19 November, also with AI assistance. The organisers asked participants to bring data and ideas and to download large data sets in advance. Everything is built from open data only.

## Where it should go next

- Replace the mud-weight estimate with measured formation pressures read from the reports.
- Read cement tops, casing programmes and mud type for the development wells themselves, so each wellbore is judged on its own.
- Calibrate the clay signature against published smectite measurements.
- Let an operator drop in a bond log and compare it with the prediction.
- The same screen applies to legacy wells inside CO₂ storage licences, which the map can already show.
