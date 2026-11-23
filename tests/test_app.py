import json
from datetime import datetime

import pytest

import app as mrtdle


@pytest.fixture
def client():
    mrtdle.app.testing = True
    return mrtdle.app.test_client()


def idx(name):
    return mrtdle.NAME_TO_IDX[name.casefold()]


def test_station_data_is_complete():
    stations = mrtdle.STATIONS
    assert len(stations) == len(mrtdle.STOPS) == len(mrtdle.DISTANCES["km"])
    # Matrices are symmetric with zero diagonal.
    for i in range(len(stations)):
        assert mrtdle.STOPS[i][i] == 0 and mrtdle.DISTANCES["km"][i][i] == 0
        for j in range(i):
            assert mrtdle.STOPS[i][j] == mrtdle.STOPS[j][i]
            assert mrtdle.DISTANCES["km"][i][j] == mrtdle.DISTANCES["km"][j][i]


@pytest.mark.parametrize("a,b,stops", [
    ("Jurong East", "Clementi", 1),       # adjacent on EW
    ("Tanah Merah", "Expo", 1),           # Changi Airport branch
    ("Bayfront", "Promenade", 1),         # Circle Line loop link
    ("HarbourFront", "Keppel", 1),        # Circle Line Stage 6
    ("Dhoby Ghaut", "Outram Park", 3),    # via North East Line
])
def test_stops_between_stations(a, b, stops):
    assert mrtdle.STOPS[idx(a)][idx(b)] == stops


def test_hint_statuses():
    target = idx("Tampines")  # EW + DT, above ground + underground
    exact = mrtdle.make_hint(target, target)
    assert exact["correct"]
    assert all(exact[k]["status"] == "correct" for k in ("lines", "structure", "distance", "stops"))
    assert exact["distance"]["bearing"] is None

    simei = mrtdle.make_hint(idx("Simei"), target)  # EW only, above ground, next stop
    assert simei["lines"]["status"] == "partial"
    assert simei["structure"]["status"] == "partial"
    assert simei["distance"]["status"] == "partial"
    assert simei["stops"] == {"value": 1, "status": "partial"}

    far = mrtdle.make_hint(idx("Woodlands North"), target)  # TE only, underground
    assert far["lines"]["status"] == "wrong"
    assert far["distance"]["status"] == "wrong"
    assert far["stops"]["status"] == "wrong"


def test_daily_rotation_covers_every_station():
    n = len(mrtdle.STATIONS)
    assert sorted(mrtdle.target_index(g) for g in range(1, n + 1)) == list(range(n))


def test_game_number_uses_singapore_time():
    # 16:30 UTC on 22 Nov is already 23 Nov in Singapore (launch day).
    assert mrtdle.today_game_number(datetime.fromisoformat("2026-11-22T16:30:00+00:00")) == 1
    assert mrtdle.today_game_number(datetime.fromisoformat("2026-11-22T15:30:00+00:00")) == 0


def test_stations_endpoint_does_not_leak_answer(client):
    body = client.get("/api/stations").get_json()
    assert len(body["stations"]) == len(mrtdle.STATIONS)
    assert "answer" not in json.dumps(body).lower()


def test_guess_endpoint(client):
    game = client.get("/api/today").get_json()["game"]
    answer = mrtdle.STATIONS[mrtdle.target_index(game)]["name"]
    res = client.post("/api/guess", json={"game": game, "station": answer.upper()})
    assert res.status_code == 200 and res.get_json()["correct"] is True


@pytest.mark.parametrize("payload", [
    {"station": "Not A Station"},
    {"station": "Bishan", "game": 10**6},   # future game
    {"station": "Bishan", "game": "abc"},
])
def test_guess_endpoint_rejects_bad_input(client, payload):
    res = client.post("/api/guess", json=payload)
    assert res.status_code == 400 and "error" in res.get_json()


def test_index_renders(client):
    res = client.get("/")
    assert res.status_code == 200 and b"guess-input" in res.data
