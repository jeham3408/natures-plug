#!/usr/bin/env python
"""predict_logs.py - predict well-log values from seismic where there is no well, and test it blind.

    python predict_logs.py --cube name=DIR [--cube name=DIR ...] --shift WELL=MS [...]
                           [--ncs MODEL] [--out-metrics FILE]

For every well with logs in the given cubes (wells.json from prep_wells.py) the inline through the well is turned
into features on a grid of 16 ms by 16 traces, and the logs (smoothed to the same 32 ms resolution) are the
answer key at the well trace.  Three sets of features are compared:

  time      two-way time below the sea bed and its square: the compaction trend, no seismic at all (the baseline)
  attr      time + classic attributes of the trace: relative impedance (integrated trace, trend removed), envelope,
            RMS amplitude and instantaneous frequency
  ncs       time + the first principal components of the patch embeddings of the NCS seismic foundation model
            (Ordonez et al. 2026, arXiv:2603.23211; NorskRegnesentralSTI/NCS-v1-2d-base, frozen, not fine-tuned)

The regression is a ridge regression.  The test is leave-one-well-out: the model never sees the well it is scored
on.  A model is only worth anything if it beats "time" in that test.  The scores are Pearson correlation and RMS
error against the smoothed log.

The logs are placed in time with the bulk shifts of the app's well tie (--shift).  Gamma ray is not calibrated
between wells of different vintages and is predicted as it is.  16 ms by 16 traces is the grid of the foundation
model's patches after shifting the crops four times in time; nothing finer than about 30 ms can come out.

The NCS features need torch, transformers and the NCS package (github.com/NorskRegnesentral/NCS_models,
Apache-2.0); without --ncs only "time" and "attr" are run, with numpy and scipy alone.
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np
from scipy.signal import hilbert

DT = 4.0                 # ms, the sampling the features are computed at (2 ms cubes are averaged in pairs)
N_T = 512                # samples used: 0 to 2044 ms
PATCH = 16               # samples and traces per patch of the foundation model
CROP = 224
STEP_T = 4               # the crops are shifted by this many samples -> one feature every 16 ms
PROPS = (("vp", "vp", "m/s"), ("gr", "gr", "API"), ("ai", "ai", "m/s·g/cm³"))


def boxcar(a, n):
    """Running mean over n samples along axis 0, NaN-aware."""
    a = np.asarray(a, float)
    ok = np.isfinite(a)
    k = np.ones(n)
    num = np.apply_along_axis(lambda v: np.convolve(v, k, "same"), 0, np.where(ok, a, 0.0))
    den = np.apply_along_axis(lambda v: np.convolve(v, k, "same"), 0, ok.astype(float))
    return np.where(den > 0, num / np.maximum(den, 1e-9), np.nan)


def load_section(cube_dir, meta, i):
    """Inline i as (n_xl, N_T) at 4 ms, divided by the cube's standard deviation and clipped at 3 (the model's own
    preprocessing)."""
    cube = np.load(os.path.join(cube_dir, "cube_ixt.npy"), mmap_mode="r")
    s = np.asarray(cube[i], dtype=np.float32)
    if abs(meta["dt_ms"] - 2.0) < 1e-6:
        s = 0.5 * (s[:, 0::2][:, : s.shape[1] // 2] + s[:, 1::2][:, : s.shape[1] // 2])
    elif abs(meta["dt_ms"] - 4.0) > 1e-6:
        raise SystemExit("only 2 ms and 4 ms cubes are handled")
    if s.shape[1] < N_T:
        s = np.pad(s, ((0, 0), (0, N_T - s.shape[1])))
    s = s[:, :N_T]
    sd = float(meta["amp"]["rms"]) or 1.0
    return np.clip(s / sd, -3.0, 3.0)


def fine_times(t0_ms):
    """Centre times (ms) of the feature rows: every 16 ms."""
    n = (N_T - PATCH) // STEP_T + 1
    return t0_ms + (PATCH / 2 + STEP_T * np.arange(n)) * DT


def classic_attributes(sec, t0_ms):
    """(n_coarse_x, n_fine_t, 4): relative impedance, envelope, RMS amplitude, instantaneous frequency, on the
    feature grid (mean over 16 traces, 32 ms)."""
    n_x = sec.shape[0] // PATCH
    blk = sec[: n_x * PATCH].reshape(n_x, PATCH, N_T)
    out = np.zeros((n_x, len(fine_times(t0_ms)), 4), np.float32)
    w = int(round(32.0 / DT)) | 1
    long = int(round(240.0 / DT)) | 1
    for q in range(n_x):
        tr = blk[q].T                                             # (N_T, 16)
        imp = np.cumsum(tr, axis=0)
        imp = imp - boxcar(imp, long)                             # band-limited: the trend is not in the seismic
        an = hilbert(tr, axis=0)
        env = np.abs(an)
        ph = np.unwrap(np.angle(an), axis=0)
        ifr = np.gradient(ph, DT / 1000.0, axis=0) / (2 * np.pi)
        ifr = np.clip(ifr, 0, 125)
        rms = np.sqrt(boxcar(tr ** 2, int(round(100.0 / DT)) | 1))
        stack = np.stack([boxcar(imp, w).mean(1), boxcar(env, w).mean(1), rms.mean(1), boxcar(ifr, w * 2 + 1).mean(1)], axis=1)
        idx = (PATCH // 2 + STEP_T * np.arange(out.shape[1])).astype(int)
        out[q] = stack[idx]
    return out


def ncs_embeddings(sec, model, torch):
    """(n_coarse_x, n_fine_t, hidden): patch embeddings of the frozen encoder, crops of 224 x 224 with half overlap,
    shifted four times in time, blended with weights that fall off towards the crop edges."""
    n_x = sec.shape[0] // PATCH
    n_ft = (N_T - PATCH) // STEP_T + 1
    pad = np.pad(sec, ((0, 0), (0, PATCH)))                       # room for the time shifts
    hidden = model.config.hidden_size
    acc = np.zeros((n_x, n_ft, hidden), np.float32)
    wsum = np.zeros((n_x, n_ft, 1), np.float32)
    npp = CROP // PATCH
    ramp = np.minimum(np.arange(npp) + 1, npp - np.arange(npp)).astype(np.float32)
    wgt = ramp[:, None] * ramp[None, :]                           # (time patches, space patches)
    xs = sorted(set(list(range(0, sec.shape[0] - CROP + 1, CROP // 2)) + [(sec.shape[0] - CROP) // PATCH * PATCH]))
    ts = sorted(set(list(range(0, N_T - CROP + 1, CROP // 2)) + [N_T - CROP]))
    jobs = [(x0, t0, ot) for x0 in xs for t0 in ts for ot in range(0, PATCH, STEP_T)]
    for b0 in range(0, len(jobs), 16):
        batch = jobs[b0:b0 + 16]
        x = np.stack([pad[x0:x0 + CROP, t0 + ot:t0 + ot + CROP].T for x0, t0, ot in batch])[:, None]   # (B, 1, time, space)
        x = np.repeat(x, model.config.num_channels, axis=1)       # the 2D model takes the one channel three times, as its own processor does
        with torch.no_grad():
            f = model(pixel_values=torch.from_numpy(np.ascontiguousarray(x))).last_hidden_state[:, 1:, :]
        f = f.reshape(len(batch), npp, npp, hidden).numpy()       # (B, time patch, space patch, hidden)
        for (x0, t0, ot), fb in zip(batch, f):
            cx = x0 // PATCH
            for p in range(npp):                                  # the patch at time t0 + ot + 16 p covers fine row ...
                k = (t0 + ot + PATCH * p) // STEP_T
                if 0 <= k < n_ft:
                    acc[cx:cx + npp, k] += fb[p] * wgt[p][:, None]
                    wsum[cx:cx + npp, k] += wgt[p][:, None]
    return acc / np.maximum(wsum, 1e-6)


def ridge_fit(X, y, alpha):
    mu, sd = X.mean(0), X.std(0) + 1e-9
    Z = (X - mu) / sd
    ym = y.mean()
    w = np.linalg.solve(Z.T @ Z + alpha * np.eye(Z.shape[1]), Z.T @ (y - ym))
    return mu, sd, w, ym


def ridge_predict(m, X):
    mu, sd, w, ym = m
    return ((X - mu) / sd) @ w + ym


def fit_with_cv(groups, X, y, alphas=(1.0, 10.0, 100.0, 1000.0)):
    """Ridge with alpha chosen by leave-one-group-out inside the training set (groups = wells)."""
    names = sorted(set(groups))
    best = (np.inf, alphas[1])
    if len(names) >= 2:
        for a in alphas:
            err = 0.0
            for g in names:
                tr, te = groups != g, groups == g
                err += float(np.sum((ridge_predict(ridge_fit(X[tr], y[tr], a), X[te]) - y[te]) ** 2))
            if err < best[0]:
                best = (err, a)
    return ridge_fit(X, y, best[1]), best[1]


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--cube", action="append", required=True, help="name=folder of a prepared cube with wells.json")
    ap.add_argument("--shift", action="append", default=[], help="WELL=ms, the bulk shift of the app's well tie")
    ap.add_argument("--ncs", default=None, help="Hugging Face id or folder of the NCS 2D model; omit to skip it")
    ap.add_argument("--pcs", type=int, default=12, help="principal components of the embeddings kept")
    ap.add_argument("--out-metrics", default=None, help="write the blind-test table here as JSON (for the app's data folder)")
    a = ap.parse_args(argv)
    shifts = {s.rpartition("=")[0]: float(s.rpartition("=")[2]) for s in a.shift}

    model = torch = None
    if a.ncs:
        import torch
        import NCS.models  # noqa: F401  registers the model types
        from transformers import AutoConfig, AutoModel
        from transformers.models.auto.configuration_auto import CONFIG_MAPPING
        cfg = AutoConfig.from_pretrained(a.ncs)
        if cfg.model_type.endswith("_mae"):                        # pretraining checkpoint: load the encoder only
            d = cfg.to_dict()
            d.pop("model_type", None)
            cfg = CONFIG_MAPPING[cfg.model_type.removesuffix("_mae")].from_dict(d)
        model = AutoModel.from_pretrained(a.ncs, config=cfg, torch_dtype=torch.float32).eval()
        print("NCS model: %s, %d parameters, hidden %d" % (a.ncs, sum(p.numel() for p in model.parameters()), cfg.hidden_size), flush=True)

    # ---- features of the inline through every logged well ----
    S = []                                                         # one entry per well
    for entry in a.cube:
        ds, _, cdir = entry.rpartition("=")
        meta = json.load(open(os.path.join(cdir, "meta.json")))
        wells = json.load(open(os.path.join(cdir, "wells.json")))["wells"]
        for w in wells:
            L = w.get("logs")
            if not L or "vp" not in L:
                continue
            i = int(round((w["il"] - meta["il0"]) / meta["il_step"]))
            j = int(round((w["xl"] - meta["xl0"]) / meta["xl_step"]))
            sec = load_section(cdir, meta, i)
            tf = fine_times(meta["t0_ms"])
            feats = {"attr": classic_attributes(sec, meta["t0_ms"])}
            cache = os.path.join(cdir, "ncs_il%d.npy" % (meta["il0"] + i * meta["il_step"]))
            if model is not None:
                if os.path.isfile(cache):
                    feats["ncs_raw"] = np.load(cache)
                else:
                    feats["ncs_raw"] = ncs_embeddings(sec, model, torch)
                    np.save(cache, feats["ncs_raw"].astype(np.float16))
                print("  %s %s: embeddings %s" % (ds, w["name"], feats["ncs_raw"].shape), flush=True)
            sh = shifts.get(w["name"], 0.0)
            tl = L["t0"] + L["dt"] * np.arange(L["n"]) + sh
            n_s = int(round(32.0 / L["dt"])) | 1
            y = {}
            for key, src, _ in PROPS:
                v = np.array([np.nan if q is None else q for q in L[src]], float)
                vs = boxcar(v, n_s)
                y[key] = np.interp(tf, tl, np.where(np.isfinite(vs), vs, 0.0), left=np.nan, right=np.nan)
                y[key][np.interp(tf, tl, np.isfinite(vs).astype(float), left=0, right=0) < 0.99] = np.nan
            S.append(dict(ds=ds, cdir=cdir, meta=meta, well=w, i=i, cx=min(j // PATCH, feats["attr"].shape[0] - 1), tf=tf,
                          tau=(tf - w["seabed_twt"]) / 1000.0, feats=feats, y=y, shift=sh))
            print("%s %s: inline %d, %d coarse traces, logs on %d of %d feature rows" % (
                ds, w["name"], meta["il0"] + i * meta["il_step"], feats["attr"].shape[0], int(np.isfinite(y["vp"]).sum()), len(tf)), flush=True)

    # ---- principal components of the embeddings, fitted on all sections (no labels involved) ----
    if model is not None:
        pool = np.concatenate([s["feats"]["ncs_raw"].astype(np.float32)[::2, ::2].reshape(-1, s["feats"]["ncs_raw"].shape[-1]) for s in S])
        mu = pool.mean(0)
        _, sv, vt = np.linalg.svd(pool - mu, full_matrices=False)
        comp = vt[: a.pcs]
        print("embedding PCA: %d components hold %.0f %% of the variance" % (a.pcs, 100 * (sv[: a.pcs] ** 2).sum() / (sv ** 2).sum()), flush=True)
        for s in S:
            s["feats"]["ncs"] = (s["feats"]["ncs_raw"].astype(np.float32) - mu) @ comp.T
    sets = ["time", "attr"] + (["ncs"] if model is not None else [])

    def design(s, kind, cx=None, tau=None):
        """Feature matrix for one coarse trace (default: the well trace)."""
        cx = s["cx"] if cx is None else cx
        tau = s["tau"] if tau is None else tau
        cols = [tau, tau ** 2]
        if kind != "time":
            cols += list(s["feats"][kind][cx].T)
        return np.stack(cols, axis=1)

    # ---- leave-one-well-out ----
    table, curves = [], {}
    for key, _, unit in PROPS:
        for held in S:
            row = dict(prop=key, unit=unit, well=held["well"]["name"], cube=held["ds"])
            yt = held["y"][key]
            okt = np.isfinite(yt) & (held["tau"] > 0)
            if okt.sum() < 10:
                continue
            row["n"] = int(okt.sum())
            for kind in sets:
                Xs, ys, gs = [], [], []
                for s in S:
                    if s is held:
                        continue
                    ok = np.isfinite(s["y"][key]) & (s["tau"] > 0)
                    Xs.append(design(s, kind)[ok]); ys.append(s["y"][key][ok]); gs += [s["well"]["name"]] * int(ok.sum())
                m, alpha = fit_with_cv(np.array(gs), np.concatenate(Xs), np.concatenate(ys))
                p = ridge_predict(m, design(held, kind))
                r = float(np.corrcoef(p[okt], yt[okt])[0, 1])
                row[kind] = dict(r=round(r, 2), rmse=round(float(np.sqrt(np.mean((p[okt] - yt[okt]) ** 2))), 1), alpha=alpha)
                if kind == "time":
                    p_time = p
                else:                                                # what the seismic adds: does it explain what the trend misses?
                    rr = float(np.corrcoef((p - p_time)[okt], (yt - p_time)[okt])[0, 1])
                    row[kind]["r_resid"] = round(rr, 2) if np.isfinite(rr) else None
                curves.setdefault(held["well"]["name"], {}).setdefault(key, {})[kind] = [None if not np.isfinite(v) else round(float(v), 1) for v in p]
            curves[held["well"]["name"]][key]["log"] = [None if not np.isfinite(v) else round(float(v), 1) for v in yt]
            table.append(row)

    print("\nBlind test, leave one well out (r = correlation with the smoothed log, rmse in the log's unit):")
    for row in table:
        print("  %-3s %-8s n=%3d  " % (row["prop"], row["well"], row["n"]) + "  ".join(
            "%s r=%+.2f rmse=%7.1f%s" % (k, row[k]["r"], row[k]["rmse"], "" if k == "time" or row[k].get("r_resid") is None else " resid r=%+.2f" % row[k]["r_resid"]) for k in sets))
    summary = {}
    for key, _, unit in PROPS:
        rows = [r for r in table if r["prop"] == key]
        summary[key] = {k: dict(mean_r=round(float(np.mean([r[k]["r"] for r in rows])), 2), mean_rmse=round(float(np.mean([r[k]["rmse"] for r in rows])), 1),
                                wins_over_time=int(sum(r[k]["rmse"] < r["time"]["rmse"] for r in rows)), wells=len(rows),
                                mean_r_resid=None if k == "time" else round(float(np.mean([r[k].get("r_resid") or 0.0 for r in rows])), 2)) for k in sets}
        print("  %-3s mean: " % key + "  ".join("%s r=%+.2f rmse=%7.1f%s" % (
            k, summary[key][k]["mean_r"], summary[key][k]["mean_rmse"],
            "" if k == "time" else " resid r=%+.2f, lower rmse than time in %d of %d" % (summary[key][k]["mean_r_resid"], summary[key][k]["wins_over_time"], len(rows))) for k in sets))

    # ---- final models (all wells) -> predicted sections along the inline through each well ----
    final = {}
    for key, _, _ in PROPS:
        for kind in sets:
            Xs, ys, gs = [], [], []
            for s in S:
                ok = np.isfinite(s["y"][key]) & (s["tau"] > 0)
                Xs.append(design(s, kind)[ok]); ys.append(s["y"][key][ok]); gs += [s["well"]["name"]] * int(ok.sum())
            final[(key, kind)] = fit_with_cv(np.array(gs), np.concatenate(Xs), np.concatenate(ys))[0]
    by_cube = {}
    for s in S:
        m = s["meta"]
        n_x = s["feats"]["attr"].shape[0]
        sec = dict(well=s["well"]["name"], il=m["il0"] + s["i"] * m["il_step"], xl0=m["xl0"] + (PATCH / 2 - 0.5) * m["xl_step"],
                   dxl=PATCH * m["xl_step"], n_x=n_x, t0=float(s["tf"][0]), dt=STEP_T * DT, n_t=len(s["tf"]), shift=s["shift"], grids={},
                   curves=curves.get(s["well"]["name"], {}), times=[round(float(v), 1) for v in s["tf"]])
        # the sea bed is taken flat at the well's sea-bed time along this line (it varies by a few ms in these cubes)
        for key, _, _ in PROPS:
            for kind in sets:
                if kind == "time":
                    continue
                g = np.stack([ridge_predict(final[(key, kind)], design(s, kind, cx=q)) for q in range(n_x)])   # (n_x, n_t)
                g[:, s["tau"] <= 0] = np.nan
                sec["grids"][key + ":" + kind] = [[None if not np.isfinite(v) else int(round(float(v))) for v in rowv] for rowv in g]
        by_cube.setdefault(s["cdir"], []).append(sec)
    for cdir, secs in by_cube.items():
        out = dict(sets=[k for k in sets if k != "time"], props=[dict(key=k, unit=u) for k, _, u in PROPS], sections=secs,
                   table=[r for r in table if any(r["well"] == q["well"] for q in secs)], summary=summary,
                   note="Ridge regression on features of the inline through each well; curves are blind (the well was left out), "
                        "sections come from the model trained on all wells. Resolution about 32 ms by 16 traces.")
        with open(os.path.join(cdir, "pred.json"), "w") as fh:
            json.dump(out, fh, separators=(",", ":"))
        print("wrote %s (%.1f MB)" % (os.path.join(cdir, "pred.json"), os.path.getsize(os.path.join(cdir, "pred.json")) / 1e6))
    if a.out_metrics:
        with open(a.out_metrics, "w") as fh:
            json.dump(dict(table=table, summary=summary, sets=sets, model=a.ncs, shifts=shifts), fh, indent=1)
        print("wrote", a.out_metrics)


if __name__ == "__main__":
    main()
