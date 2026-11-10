"""Build the site data from the GPX files in trails/.

For every trails/<slug>.gpx (with an optional trails/<slug>.yaml next to it):
  - compute distance, elevation gain/loss, min/max altitude
  - detect loop vs point-to-point
  - resample an elevation profile and simplify the map geometry
  - write a cleaned GPX (no timestamps, author, device, extensions)
Outputs:
  site/data/trails.json
  site/data/config.json
  site/gpx/<slug>.gpx

Usage:  uv run scripts/build.py
"""

from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

import gpxpy
import gpxpy.gpx
import yaml

ROOT = Path(__file__).resolve().parent.parent
TRAILS_DIR = ROOT / "trails"
SITE_DIR = ROOT / "site"
DATA_DIR = SITE_DIR / "data"
GPX_OUT_DIR = SITE_DIR / "gpx"

DIFFICULTIES = {"T", "E", "EE", "EEA"}
ACTIVITIES = {"trail", "hike"}
PROFILE_POINTS = 400        # resampled points for the elevation chart
SIMPLIFY_TOLERANCE_M = 4.0  # Douglas-Peucker tolerance for the map line
ELE_SMOOTH_WINDOW = 5       # moving-average window (points) before gain calc
ELE_HYSTERESIS_M = 3.0      # ignore elevation wiggles smaller than this
WATER_RE = re.compile(r"water|acqua|fontan|fountain|sorgente|spring|drinking", re.I)

EARTH_R = 6371008.8


# ----------------------------------------------------------------- geometry
def haversine(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(math.sqrt(a))


def simplify(points: list[tuple[float, float]], tol_m: float) -> list[tuple[float, float]]:
    """Iterative Douglas-Peucker on a local equirectangular projection."""
    if len(points) < 3:
        return points
    lat0 = math.radians(points[0][0])
    kx = EARTH_R * math.cos(lat0) * math.pi / 180
    ky = EARTH_R * math.pi / 180
    xy = [(lon * kx, lat * ky) for lat, lon in points]

    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = xy[a]
        bx, by = xy[b]
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        dmax, imax = 0.0, -1
        for i in range(a + 1, b):
            px, py = xy[i]
            if seg2 == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
                d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
            if d > dmax:
                dmax, imax = d, i
        if dmax > tol_m and imax > 0:
            keep[imax] = True
            stack.append((a, imax))
            stack.append((imax, b))
    return [p for p, k in zip(points, keep) if k]


def smooth(values: list[float], window: int) -> list[float]:
    if window < 2 or len(values) < window:
        return values[:]
    half = window // 2
    out = []
    for i in range(len(values)):
        lo, hi = max(0, i - half), min(len(values), i + half + 1)
        out.append(sum(values[lo:hi]) / (hi - lo))
    return out


def gain_loss(ele: list[float]) -> tuple[float, float]:
    """Elevation gain/loss with hysteresis to reject GPS/barometer noise."""
    if not ele:
        return 0.0, 0.0
    up = down = 0.0
    ref = ele[0]
    for e in ele[1:]:
        diff = e - ref
        if diff >= ELE_HYSTERESIS_M:
            up += diff
            ref = e
        elif diff <= -ELE_HYSTERESIS_M:
            down -= diff
            ref = e
    return up, down


# ----------------------------------------------------------------- helpers
def localized(value, field: str, slug: str) -> dict:
    """Accept either a plain string or {it:..., en:...}."""
    if value is None:
        return {}
    if isinstance(value, str):
        return {"it": value, "en": value}
    if isinstance(value, dict):
        return {k: str(v).strip() for k, v in value.items() if v}
    raise ValueError(f"{slug}: '{field}' must be a string or an it/en mapping")


def read_points(gpx: gpxpy.gpx.GPX) -> list[tuple[float, float, float | None]]:
    pts = []
    for trk in gpx.tracks:
        for seg in trk.segments:
            pts += [(p.latitude, p.longitude, p.elevation) for p in seg.points]
    if not pts:  # some planners export routes instead of tracks
        for rte in gpx.routes:
            pts += [(p.latitude, p.longitude, p.elevation) for p in rte.points]
    return pts


def fill_missing_ele(ele: list[float | None]) -> list[float] | None:
    known = [i for i, e in enumerate(ele) if e is not None]
    if len(known) < 2:
        return None
    out = list(ele)
    for i in range(len(out)):
        if out[i] is None:
            prev = max((k for k in known if k < i), default=None)
            nxt = min((k for k in known if k > i), default=None)
            out[i] = ele[prev] if nxt is None else ele[nxt] if prev is None else (
                ele[prev] + (ele[nxt] - ele[prev]) * (i - prev) / (nxt - prev))
    return out


def resample_profile(cum, lats, lons, eles, n):
    total = cum[-1]
    if total == 0:
        return []
    out, j = [], 0
    for k in range(n + 1):
        d = total * k / n
        while j < len(cum) - 2 and cum[j + 1] < d:
            j += 1
        span = cum[j + 1] - cum[j]
        t = 0 if span == 0 else (d - cum[j]) / span
        lat = lats[j] + (lats[j + 1] - lats[j]) * t
        lon = lons[j] + (lons[j + 1] - lons[j]) * t
        ele = None if eles is None else eles[j] + (eles[j + 1] - eles[j]) * t
        out.append([round(d / 1000, 3), None if ele is None else round(ele, 1),
                    round(lat, 6), round(lon, 6)])
    return out


# ----------------------------------------------------------------- per trail
def process_trail(gpx_path: Path, cfg: dict) -> dict:
    slug = gpx_path.stem
    meta_path = gpx_path.with_suffix(".yaml")
    meta = yaml.safe_load(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
    meta = meta or {}

    with gpx_path.open(encoding="utf-8") as fh:
        src = gpxpy.parse(fh)

    pts = read_points(src)
    if len(pts) < 2:
        raise ValueError(f"{slug}: no track points found")

    lats = [p[0] for p in pts]
    lons = [p[1] for p in pts]
    eles = fill_missing_ele([p[2] for p in pts])

    cum = [0.0]
    for i in range(1, len(pts)):
        cum.append(cum[-1] + haversine(lats[i - 1], lons[i - 1], lats[i], lons[i]))
    dist = cum[-1]

    if eles:
        sm = smooth(eles, ELE_SMOOTH_WINDOW)
        up, down = gain_loss(sm)
        ele_stats = {"gain": round(up), "loss": round(down),
                     "max": round(max(eles)), "min": round(min(eles))}
    else:
        print(f"  ! {slug}: no elevation data", file=sys.stderr)
        ele_stats = {"gain": None, "loss": None, "max": None, "min": None}

    # loop / point-to-point
    gap = haversine(lats[0], lons[0], lats[-1], lons[-1])
    auto_type = "loop" if gap <= cfg.get("loop_threshold_m", 300) else "point"
    trail_type = meta.get("type", auto_type)
    if trail_type not in ("loop", "point"):
        raise ValueError(f"{slug}: type must be 'loop' or 'point'")

    # Hub proximity
    hub = cfg.get("hub") or {}
    from_hub = meta.get("from_hub")
    if from_hub is None and hub.get("lat") is not None:
        from_hub = haversine(lats[0], lons[0], hub["lat"], hub["lon"]) <= hub.get("hub_radius_m", 600)

    # validation of the extra fields
    difficulty = meta.get("difficulty")
    if difficulty is not None and difficulty not in DIFFICULTIES:
        raise ValueError(f"{slug}: difficulty must be one of {sorted(DIFFICULTIES)}")
    activity = meta.get("activity", ["hike"])
    if isinstance(activity, str):
        activity = [activity]
    bad = set(activity) - ACTIVITIES
    if bad:
        raise ValueError(f"{slug}: unknown activity {bad}; use {sorted(ACTIVITIES)}")
    season = [int(m) for m in meta.get("season", [])]
    if any(m < 1 or m > 12 for m in season):
        raise ValueError(f"{slug}: season months must be 1-12")

    # points of interest: GPX waypoints + yaml water points
    pois = []
    for w in src.waypoints:
        label = " ".join(filter(None, [w.name, w.symbol, w.type]))
        pois.append({"name": w.name or "", "lat": round(w.latitude, 6), "lon": round(w.longitude, 6),
                     "kind": "water" if WATER_RE.search(label) else "poi"})
    for w in meta.get("water", []) or []:
        pois.append({"name": w.get("name", ""), "lat": float(w["lat"]), "lon": float(w["lon"]),
                     "kind": "water"})
    for p in meta.get("poi", []) or []:
        pois.append({"name": p.get("name", ""), "lat": float(p["lat"]), "lon": float(p["lon"]),
                     "kind": "poi"})

    title = localized(meta.get("title"), "title", slug) or localized(
        (src.tracks[0].name if src.tracks and src.tracks[0].name else None) or src.name
        or slug.replace("-", " ").title(), "title", slug)

    # cleaned GPX: only geometry + elevation, no personal metadata
    clean = gpxpy.gpx.GPX()
    clean.creator = cfg["site"]["title"]
    clean.name = title.get("it") or slug
    trk = gpxpy.gpx.GPXTrack(name=clean.name)
    seg = gpxpy.gpx.GPXTrackSegment()
    for i in range(len(pts)):
        seg.points.append(gpxpy.gpx.GPXTrackPoint(
            round(lats[i], 6), round(lons[i], 6),
            elevation=None if eles is None else round(eles[i], 1)))
    trk.segments.append(seg)
    clean.tracks.append(trk)
    for p in pois:
        clean.waypoints.append(gpxpy.gpx.GPXWaypoint(
            p["lat"], p["lon"], name=p["name"] or None,
            symbol="Drinking Water" if p["kind"] == "water" else None))
    (GPX_OUT_DIR / f"{slug}.gpx").write_text(clean.to_xml(), encoding="utf-8")

    line = simplify(list(zip(lats, lons)), SIMPLIFY_TOLERANCE_M)

    return {
        "slug": slug,
        "title": title,
        "description": localized(meta.get("description"), "description", slug),
        "snow": localized(meta.get("snow"), "snow", slug),
        "difficulty": difficulty,
        "activity": activity,
        "season": season,
        "type": trail_type,
        "from_hub": bool(from_hub),
        "distance_km": round(dist / 1000, 2),
        **{f"ele_{k}": v for k, v in ele_stats.items()},
        "start": [round(lats[0], 6), round(lons[0], 6)],
        "bounds": [[min(lats), min(lons)], [max(lats), max(lons)]],
        "line": [[round(a, 5), round(b, 5)] for a, b in line],
        "profile": resample_profile(cum, lats, lons, eles, PROFILE_POINTS),
        "pois": pois,
        "gpx": f"gpx/{slug}.gpx",
        "order": meta.get("order", 999),
    }


def main() -> int:
    cfg = yaml.safe_load((ROOT / "config.yaml").read_text(encoding="utf-8"))
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    GPX_OUT_DIR.mkdir(parents=True, exist_ok=True)
    for old in GPX_OUT_DIR.glob("*.gpx"):
        old.unlink()

    trails, errors = [], 0
    for gpx_path in sorted(TRAILS_DIR.glob("*.gpx")):
        try:
            t = process_trail(gpx_path, cfg)
            trails.append(t)
            print(f"  ✓ {t['slug']}: {t['distance_km']} km, D+ {t['ele_gain']} m, {t['type']}")
        except Exception as exc:  # report every broken file, then fail
            errors += 1
            print(f"  ✗ {gpx_path.name}: {exc}", file=sys.stderr)

    trails.sort(key=lambda t: (t["order"], t["title"].get("it", t["slug"])))
    (DATA_DIR / "trails.json").write_text(
        json.dumps(trails, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    public_cfg = {"site": cfg["site"], "hub": cfg.get("hub"), "map": cfg.get("map", {})}
    (DATA_DIR / "config.json").write_text(json.dumps(public_cfg, ensure_ascii=False), encoding="utf-8")

    print(f"Built {len(trails)} trail(s) → {DATA_DIR.relative_to(ROOT)}/trails.json")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
