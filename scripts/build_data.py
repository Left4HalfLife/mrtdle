"""Build MRTdle station data.

Downloads the Singapore rail dataset (station names/codes from Wikipedia,
coordinates from LTA/OSM) compiled by https://github.com/cheeaun/sgraildata,
then adds line structure info (underground / above ground, per Wikipedia),
builds the rail graph and precomputes:

  data/stations.json   station list, lines, structure, coordinates, edges
  data/distances.json  straight-line km + bearing between every pair of stations
  data/stops.json      fewest stations between every pair (transfers allowed)

Run:  python scripts/build_data.py
"""

import json
import math
import re
import sys
import urllib.request
from collections import deque
from pathlib import Path

SOURCE_URL = (
    "https://raw.githubusercontent.com/cheeaun/sgraildata/master/data/v1/sg-rail.geojson"
)
DATA_DIR = Path(__file__).resolve().parent.parent / "data"

LINES = {
    "NS": {"name": "North South Line", "color": "#d42e12"},
    "EW": {"name": "East West Line", "color": "#009645"},
    "NE": {"name": "North East Line", "color": "#9900aa"},
    "CC": {"name": "Circle Line", "color": "#fa9e0d"},
    "DT": {"name": "Downtown Line", "color": "#005ec4"},
    "TE": {"name": "Thomson-East Coast Line", "color": "#9d5b25"},
}

# Station code prefixes that belong to a main line (Changi Airport branch is EW).
PREFIX_TO_LINE = {"NS": "NS", "EW": "EW", "CG": "EW", "NE": "NE",
                  "CC": "CC", "DT": "DT", "TE": "TE"}

UNDERGROUND = "Underground"
ABOVE = "Above ground"

# NS and EW are mostly elevated/at-grade except through the city (per Wikipedia).
# NE, CC, DT and TE are fully underground.
NS_UNDERGROUND = {f"NS{n}" for n in range(18, 29)}  # Braddell .. Marina South Pier
EW_UNDERGROUND = {"EW11", "EW12", "EW13", "EW14", "EW15", "EW16", "EW17", "CG2"}

# Track links that don't follow consecutive numbering.
EXTRA_EDGES = [
    ("EW4", "CG1"),   # Tanah Merah - Expo (Changi Airport branch)
    ("CC34", "CC4"),  # Bayfront - Promenade (Circle Line loop)
]


def line_of(code):
    return PREFIX_TO_LINE[re.match(r"[A-Z]+", code).group()]


def structure_for_code(code):
    line = line_of(code)
    if line == "NS":
        return UNDERGROUND if code in NS_UNDERGROUND else ABOVE
    if line == "EW":
        return UNDERGROUND if code in EW_UNDERGROUND else ABOVE
    return UNDERGROUND


def haversine_km(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (a[1], a[0], b[1], b[0]))
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2)
    return 2 * 6371.0088 * math.asin(math.sqrt(h))


def bearing_deg(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (a[1], a[0], b[1], b[0]))
    y = math.sin(lon2 - lon1) * math.cos(lat2)
    x = (math.cos(lat1) * math.sin(lat2)
         - math.sin(lat1) * math.cos(lat2) * math.cos(lon2 - lon1))
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def load_source():
    req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": "mrtdle-data-builder"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def build(geojson):
    stations = []
    for f in geojson["features"]:
        p = f["properties"]
        if p.get("stop_type") != "station" or "singapore-mrt" not in p.get("network", ""):
            continue
        # Keep MRT codes only (drops LRT codes like BP6, STC, PTC).
        codes = [c for c in p["station_codes"].split("-")
                 if re.fullmatch(r"(NS|EW|CG|NE|CC|DT|TE)\d+", c)]
        if not codes:
            continue
        lon, lat = f["geometry"]["coordinates"][:2]
        stations.append({
            "name": p["name"],
            "codes": codes,
            "lines": sorted({line_of(c) for c in codes}, key=list(LINES).index),
            "structure": sorted({structure_for_code(c) for c in codes}),
            "lon": round(lon, 6),
            "lat": round(lat, 6),
        })

    stations.sort(key=lambda s: s["name"])
    names = [s["name"] for s in stations]
    if len(set(names)) != len(names):
        sys.exit("Duplicate station names in source data")

    code_to_idx = {c: i for i, s in enumerate(stations) for c in s["codes"]}

    # Adjacent stations: consecutive existing numbers within each code prefix
    # (skips unopened stations such as NS6 or CC18).
    by_prefix = {}
    for code, idx in code_to_idx.items():
        m = re.fullmatch(r"([A-Z]+)(\d+)", code)
        by_prefix.setdefault(m.group(1), []).append((int(m.group(2)), idx))
    edges = set()
    for prefix, items in by_prefix.items():
        items.sort()
        for (_, a), (_, b) in zip(items, items[1:]):
            edges.add((min(a, b), max(a, b), PREFIX_TO_LINE[prefix]))
    for ca, cb in EXTRA_EDGES:
        a, b = code_to_idx[ca], code_to_idx[cb]
        edges.add((min(a, b), max(a, b), line_of(ca)))
    edges = sorted(edges)

    adj = [[] for _ in stations]
    for a, b, _ in edges:
        adj[a].append(b)
        adj[b].append(a)

    n = len(stations)
    stops = []
    for src in range(n):
        dist = [-1] * n
        dist[src] = 0
        q = deque([src])
        while q:
            u = q.popleft()
            for v in adj[u]:
                if dist[v] < 0:
                    dist[v] = dist[u] + 1
                    q.append(v)
        if -1 in dist:
            sys.exit(f"Graph disconnected from {stations[src]['name']}")
        stops.append(dist)

    coords = [(s["lon"], s["lat"]) for s in stations]
    distances = {
        "km": [[round(haversine_km(coords[i], coords[j]), 2) for j in range(n)]
               for i in range(n)],
        "bearing": [[round(bearing_deg(coords[i], coords[j])) for j in range(n)]
                    for i in range(n)],
    }

    meta = {
        "lines": LINES,
        "stations": stations,
        "edges": [list(e) for e in edges],
        "attribution": (
            "Station data from github.com/cheeaun/sgraildata: contains information "
            "from LTA DataMall, URA, OneMap and data.gov.sg (Singapore Open Data "
            "Licence 1.0); © OpenStreetMap contributors (ODbL); station names from "
            "Wikipedia (CC BY-SA 4.0)."
        ),
    }
    return meta, distances, stops


def main():
    meta, distances, stops = build(load_source())
    DATA_DIR.mkdir(exist_ok=True)
    (DATA_DIR / "stations.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    (DATA_DIR / "distances.json").write_text(json.dumps(distances, separators=(",", ":")))
    (DATA_DIR / "stops.json").write_text(json.dumps(stops, separators=(",", ":")))
    print(f"Wrote {len(meta['stations'])} stations, {len(meta['edges'])} edges to {DATA_DIR}")


if __name__ == "__main__":
    main()
