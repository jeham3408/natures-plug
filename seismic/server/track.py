"""track.py - follow one seismic event from a seed through a cube (a plain extremum autotracker).

The seed is snapped to the nearest peak or trough.  From there the pick spreads to the four neighbouring traces,
then to their neighbours, and so on (a flood fill).  A neighbour gets a pick when the same kind of extremum is
found within ``max_lag`` samples of the pick it is reached from and is at least ``min_rel`` times as strong as
the seed.  A trace that fails from one side can still be reached from another side later.  Picks are refined to
a fraction of a sample with a parabola through three samples.

This is deliberately simple and has the usual weaknesses of such trackers: it can jump one cycle across a fault
or an unconformity without noticing, and it can walk around an obstacle and come back one cycle off.  The
result is a guide for the eye that must be checked on the sections, not an interpretation.
"""
from __future__ import annotations

import numpy as np


def track(cube, i0, j0, k0, max_lag=2, snap=3, min_rel=0.15):
    """cube: (n_il, n_xl, n_t) float32 (memory map is fine).  Returns (picks float32 (n_il, n_xl) in samples with
    NaN where there is no pick, info dict)."""
    n_il, n_xl, n_t = cube.shape
    tr = np.asarray(cube[i0, j0, :], dtype=np.float32)
    lo, hi = max(k0 - snap, 1), min(k0 + snap, n_t - 2)
    if hi < lo or not np.any(tr):
        raise ValueError("no seismic at the seed")
    seg = tr[lo:hi + 1]
    kp, kt = lo + int(np.argmax(seg)), lo + int(np.argmin(seg))
    cands = [(k, s) for k, s in ((kp, 1.0), (kt, -1.0)) if s * tr[k] > 0 and s * tr[k] >= s * tr[k - 1] and s * tr[k] >= s * tr[k + 1]]
    if not cands:
        raise ValueError("no peak or trough within %d samples of the seed" % snap)
    # nearest real extremum; when both a peak and a trough are in reach, weigh strength against distance
    ks, sign = max(cands, key=lambda c: abs(tr[c[0]]) * (1.0 - 0.15 * abs(c[0] - k0)))
    floor = min_rel * abs(float(tr[ks]))

    picks = np.full((n_il, n_xl), -1, dtype=np.int32)
    frac = np.zeros((n_il, n_xl), dtype=np.float32)
    picks[i0, j0] = ks
    lags = np.arange(-max_lag - 1, max_lag + 2)                 # one extra sample each side for the extremum test
    pen = 1e-4 * np.abs(lags[1:-1])                             # prefer the smallest move among near-equal values
    fi, fj = np.array([i0]), np.array([j0])
    rounds = 0
    while fi.size:
        rounds += 1
        ci, cj, ck = [], [], []
        for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ni, nj = fi + di, fj + dj
            ok = (ni >= 0) & (ni < n_il) & (nj >= 0) & (nj < n_xl)
            ni, nj, src = ni[ok], nj[ok], picks[fi[ok], fj[ok]]
            free = picks[ni, nj] < 0
            ci.append(ni[free]); cj.append(nj[free]); ck.append(src[free])
        ci, cj, ck = np.concatenate(ci), np.concatenate(cj), np.concatenate(ck)
        if not ci.size:
            break
        _, first = np.unique(ci.astype(np.int64) * n_xl + cj, return_index=True)   # one attempt per trace per round
        ci, cj, ck = ci[first], cj[first], ck[first]
        kidx = np.clip(ck[:, None] + lags[None, :], 0, n_t - 1)
        order = np.lexsort((cj, ci))                              # read the memory map in file order
        vals = np.empty(kidx.shape, dtype=np.float32)
        vals[order] = sign * np.asarray(cube[ci[order][:, None], cj[order][:, None], kidx[order]], dtype=np.float32)
        inner = vals[:, 1:-1]
        best = np.argmax(inner - pen[None, :] * np.abs(inner).max(axis=1, keepdims=True), axis=1)
        r = np.arange(ci.size)
        a, left, right = inner[r, best], vals[r, best], vals[r, best + 2]
        good = (a > floor) & (a >= left) & (a >= right)
        ci, cj = ci[good], cj[good]
        knew = kidx[r, best + 1][good]
        picks[ci, cj] = knew
        den = (left - 2 * a + right)[good]
        with np.errstate(divide="ignore", invalid="ignore"):
            f = np.where(np.abs(den) > 1e-12, 0.5 * (left[good] - right[good]) / den, 0.0)
        frac[ci, cj] = np.clip(np.nan_to_num(f), -0.5, 0.5)
        fi, fj = ci, cj

    ok = picks >= 0
    out = np.where(ok, picks + frac, np.nan).astype(np.float32)
    info = dict(seed_sample=int(ks), polarity="peak" if sign > 0 else "trough", seed_amp=float(tr[ks]),
                picked=int(ok.sum()), total=int(n_il * n_xl), max_lag=int(max_lag), min_rel=float(min_rel), rounds=rounds)
    return out, info
