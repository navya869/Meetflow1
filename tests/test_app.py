from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_health():
    response = client.get("/api/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["max_room_participants"] == 100


def test_create_and_get_meeting():
    created = client.post("/api/meetings", json={"title": "Test meeting", "duration_minutes": 30})
    assert created.status_code == 200
    meeting = created.json()
    assert len(meeting["code"]) == 8
    fetched = client.get(f"/api/meetings/{meeting['code']}")
    assert fetched.status_code == 200
    assert fetched.json()["title"] == "Test meeting"


def test_unknown_meeting():
    response = client.get("/api/meetings/NOTREAL1")
    assert response.status_code == 404


def test_notes_persist():
    created = client.post("/api/meetings", json={"title": "Notes test"})
    code = created.json()["code"]
    saved = client.put(f"/api/meetings/{code}/notes", json={"content": "Decision: ship the demo"})
    assert saved.status_code == 200
    fetched = client.get(f"/api/meetings/{code}/notes")
    assert fetched.json()["content"] == "Decision: ship the demo"
