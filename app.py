import json
import random
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from flask import Flask, abort, jsonify, render_template, request

DATA_DIR = Path(__file__).resolve().parent / "data"
SGT = timezone(timedelta(hours=8))
LAUNCH_DATE = date(2026, 11, 23)  # game #1
SHUFFLE_SEED = "mrtdle-v1"

# Hint thresholds for an orange (close) result.
CLOSE_KM = 5.0
CLOSE_STOPS = 5

META = json.loads((DATA_DIR / "stations.json").read_text(encoding="utf-8"))
STATIONS = META["stations"]
DISTANCES = json.loads((DATA_DIR / "distances.json").read_text())
STOPS = json.loads((DATA_DIR / "stops.json").read_text())
NAME_TO_IDX = {s["name"].casefold(): i for i, s in enumerate(STATIONS)}

# Fixed shuffled order so every station comes up once before any repeats.
_ORDER = list(range(len(STATIONS)))
random.Random(SHUFFLE_SEED).shuffle(_ORDER)

app = Flask(__name__)


def today_game_number(now=None):
    now = now or datetime.now(SGT)
    return (now.astimezone(SGT).date() - LAUNCH_DATE).days + 1


def target_index(game):
    return _ORDER[(game - 1) % len(_ORDER)]


def compare_sets(guess, target):
    g, t = set(guess), set(target)
    if g == t:
        return "correct"
    return "partial" if g & t else "wrong"


def compare_number(value, close):
    if value == 0:
        return "correct"
    return "partial" if value <= close else "wrong"


def make_hint(guess_idx, target_idx):
    g, t = STATIONS[guess_idx], STATIONS[target_idx]
    km = DISTANCES["km"][guess_idx][target_idx]
    stops = STOPS[guess_idx][target_idx]
    return {
        "station": g["name"],
        "codes": g["codes"],
        "correct": guess_idx == target_idx,
        "lines": {"value": g["lines"], "status": compare_sets(g["lines"], t["lines"])},
        "structure": {"value": g["structure"],
                      "status": compare_sets(g["structure"], t["structure"])},
        "distance": {"value": km, "status": compare_number(km, CLOSE_KM),
                     "bearing": None if km == 0 else DISTANCES["bearing"][guess_idx][target_idx]},
        "stops": {"value": stops, "status": compare_number(stops, CLOSE_STOPS)},
    }


def requested_game(payload):
    current = today_game_number()
    try:
        game = int(payload.get("game", current))
    except (TypeError, ValueError):
        abort(400, "Invalid game number")
    if game < 1 or game > current:
        abort(400, "That game is not available")
    return game


@app.get("/")
def index():
    return render_template("index.html", close_km=CLOSE_KM, close_stops=CLOSE_STOPS)


@app.get("/api/stations")
def api_stations():
    return jsonify({
        "lines": META["lines"],
        "stations": STATIONS,
        "edges": META["edges"],
        "attribution": META["attribution"],
    })


@app.get("/api/today")
def api_today():
    now = datetime.now(SGT)
    tomorrow = datetime.combine(now.date() + timedelta(days=1), datetime.min.time(), SGT)
    return jsonify({
        "game": today_game_number(now),
        "date": now.date().isoformat(),
        "next_in_seconds": int((tomorrow - now).total_seconds()),
    })


@app.post("/api/guess")
def api_guess():
    payload = request.get_json(silent=True) or {}
    game = requested_game(payload)
    idx = NAME_TO_IDX.get(str(payload.get("station", "")).strip().casefold())
    if idx is None:
        abort(400, "Unknown station")
    return jsonify(make_hint(idx, target_index(game)))


@app.post("/api/reveal")
def api_reveal():
    game = requested_game(request.get_json(silent=True) or {})
    return jsonify({"station": STATIONS[target_index(game)]["name"]})


@app.errorhandler(400)
def bad_request(err):
    return jsonify({"error": err.description}), 400


if __name__ == "__main__":
    app.run(debug=True)
