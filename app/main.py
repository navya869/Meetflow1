from __future__ import annotations

import asyncio
import json
import os
import secrets
import string
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import DateTime, Integer, String, Text, create_engine, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

ROOT = Path(__file__).resolve().parent.parent
STATIC = Path(__file__).resolve().parent / "static"
DATA_DIR = ROOT / "data"
RECORDINGS_DIR = ROOT / "recordings"
IS_VERCEL = os.environ.get("VERCEL") == "1"
if not IS_VERCEL:
    DATA_DIR.mkdir(exist_ok=True)
    RECORDINGS_DIR.mkdir(exist_ok=True)

database_url = os.environ.get("DATABASE_URL")
if database_url:
    if database_url.startswith("postgres://"):
        database_url = database_url.replace("postgres://", "postgresql+psycopg://", 1)
    elif database_url.startswith("postgresql://"):
        database_url = database_url.replace("postgresql://", "postgresql+psycopg://", 1)
else:
    database_path = Path(tempfile.gettempdir()) / "connectspace.db" if IS_VERCEL else DATA_DIR / "connectspace.db"
    database_url = f"sqlite:///{database_path.as_posix()}"

engine_options: dict[str, Any] = {"pool_pre_ping": True}
if database_url.startswith("sqlite:"):
    engine_options["connect_args"] = {"check_same_thread": False}
engine = create_engine(database_url, **engine_options)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class Meeting(Base):
    __tablename__ = "meetings"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(16), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(160), default="Meetflow meeting")
    description: Mapped[str] = mapped_column(Text, default="")
    scheduled_at: Mapped[str | None] = mapped_column(String(40), nullable=True)
    duration_minutes: Mapped[int] = mapped_column(Integer, default=30)
    status: Mapped[str] = mapped_column(String(20), default="scheduled")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))


class Note(Base):
    __tablename__ = "notes"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    meeting_code: Mapped[str] = mapped_column(String(16), index=True)
    content: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))


Base.metadata.create_all(engine)

app = FastAPI(title="Meetflow API", version="1.0.0")
app.mount("/static", StaticFiles(directory=STATIC), name="static")

# In-memory signaling rooms. Media itself is carried by WebRTC peer connections.
MAX_ROOM_PARTICIPANTS = 100
rooms: dict[str, dict[str, WebSocket]] = {}
room_lock = asyncio.Lock()


def make_code() -> str:
    alphabet = string.ascii_uppercase + string.digits
    with SessionLocal() as db:
        for _ in range(20):
            code = "".join(secrets.choice(alphabet) for _ in range(8))
            if not db.scalar(select(Meeting).where(Meeting.code == code)):
                return code
    raise RuntimeError("Could not generate a unique meeting code")


class MeetingCreate(BaseModel):
    title: str = Field(default="Meetflow meeting", min_length=1, max_length=160)
    description: str = Field(default="", max_length=4000)
    scheduled_at: str | None = None
    duration_minutes: int = Field(default=30, ge=5, le=720)


class NoteUpdate(BaseModel):
    content: str = Field(default="", max_length=20000)


def meeting_dict(m: Meeting) -> dict[str, Any]:
    return {
        "code": m.code,
        "title": m.title,
        "description": m.description,
        "scheduled_at": m.scheduled_at,
        "duration_minutes": m.duration_minutes,
        "status": m.status,
        "created_at": m.created_at.isoformat(),
        "url": f"/?meeting={m.code}",
    }


@app.get("/")
def home():
    return FileResponse(STATIC / "index.html")


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "app": "Meetflow",
        "database": "sqlite",
        "max_room_participants": MAX_ROOM_PARTICIPANTS,
        "room_capacity_note": "Built for up to 100 participants per room with mesh-style WebRTC signaling.",
    }


@app.get("/api/meetings")
def list_meetings():
    with SessionLocal() as db:
        meetings = db.scalars(select(Meeting).order_by(Meeting.created_at.desc()).limit(100)).all()
        return [meeting_dict(m) for m in meetings]


@app.post("/api/meetings")
def create_meeting(payload: MeetingCreate):
    with SessionLocal() as db:
        code = make_code()
        meeting = Meeting(
            code=code,
            title=payload.title.strip(),
            description=payload.description.strip(),
            scheduled_at=payload.scheduled_at,
            duration_minutes=payload.duration_minutes,
            status="scheduled" if payload.scheduled_at else "ready",
        )
        db.add(meeting)
        db.commit()
        db.refresh(meeting)
        return meeting_dict(meeting)


@app.get("/api/meetings/{code}")
def get_meeting(code: str):
    with SessionLocal() as db:
        meeting = db.scalar(select(Meeting).where(Meeting.code == code.upper()))
        if not meeting:
            raise HTTPException(status_code=404, detail="Meeting not found. Check the meeting code.")
        return meeting_dict(meeting)


@app.patch("/api/meetings/{code}/cancel")
def cancel_meeting(code: str):
    with SessionLocal() as db:
        meeting = db.scalar(select(Meeting).where(Meeting.code == code.upper()))
        if not meeting:
            raise HTTPException(status_code=404, detail="Meeting not found")
        meeting.status = "cancelled"
        db.commit()
        return meeting_dict(meeting)


@app.get("/api/meetings/{code}/notes")
def get_notes(code: str):
    with SessionLocal() as db:
        meeting = db.scalar(select(Meeting).where(Meeting.code == code.upper()))
        if not meeting:
            raise HTTPException(status_code=404, detail="Meeting not found")
        note = db.scalar(select(Note).where(Note.meeting_code == code.upper()))
        return {"content": note.content if note else ""}


@app.put("/api/meetings/{code}/notes")
def save_notes(code: str, payload: NoteUpdate):
    with SessionLocal() as db:
        meeting = db.scalar(select(Meeting).where(Meeting.code == code.upper()))
        if not meeting:
            raise HTTPException(status_code=404, detail="Meeting not found")
        note = db.scalar(select(Note).where(Note.meeting_code == code.upper()))
        if note is None:
            note = Note(meeting_code=code.upper(), content=payload.content)
            db.add(note)
        else:
            note.content = payload.content
            note.updated_at = datetime.now(timezone.utc)
        db.commit()
        return {"content": note.content, "saved": True}


async def broadcast(room: str, message: dict[str, Any], exclude: str | None = None):
    async with room_lock:
        peers = list(rooms.get(room, {}).items())
    stale = []
    for peer_id, ws in peers:
        if peer_id == exclude:
            continue
        try:
            await ws.send_text(json.dumps(message))
        except Exception:
            stale.append(peer_id)
    if stale:
        async with room_lock:
            for peer_id in stale:
                rooms.get(room, {}).pop(peer_id, None)


@app.websocket("/ws/{room}/{participant_id}")
async def websocket_endpoint(websocket: WebSocket, room: str, participant_id: str):
    room = room.upper()
    participant_id = participant_id[:80]
    with SessionLocal() as db:
        meeting = db.scalar(select(Meeting).where(Meeting.code == room))
    if not meeting or meeting.status == "cancelled":
        await websocket.accept()
        await websocket.send_text(json.dumps({"type": "error", "message": "Meeting does not exist or was cancelled."}))
        await websocket.close(code=1008)
        return

    await websocket.accept()
    async with room_lock:
        room_peers = rooms.setdefault(room, {})
        existing = list(room_peers.keys())
        if len(room_peers) >= MAX_ROOM_PARTICIPANTS:
            await websocket.send_text(
                json.dumps(
                    {
                        "type": "error",
                        "message": f"This room has reached the supported limit of {MAX_ROOM_PARTICIPANTS} participants.",
                    }
                )
            )
            await websocket.close(code=1013)
            return
        room_peers[participant_id] = websocket

    await websocket.send_text(json.dumps({"type": "existing-peers", "peers": existing}))
    await broadcast(room, {"type": "peer-joined", "peerId": participant_id}, exclude=participant_id)

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            kind = msg.get("type")
            # Never let a client choose a different sender identity.
            msg["from"] = participant_id
            if kind in {"offer", "answer", "ice", "chat", "state", "reaction", "raise-hand", "leave"}:
                target = msg.get("target")
                if target:
                    async with room_lock:
                        target_ws = rooms.get(room, {}).get(str(target))
                    if target_ws:
                        try:
                            await target_ws.send_text(json.dumps(msg))
                        except Exception:
                            pass
                elif kind in {"chat", "state", "reaction", "raise-hand", "leave"}:
                    await broadcast(room, msg, exclude=participant_id)
    except WebSocketDisconnect:
        pass
    finally:
        async with room_lock:
            peers = rooms.get(room, {})
            peers.pop(participant_id, None)
            if not peers:
                rooms.pop(room, None)
        await broadcast(room, {"type": "peer-left", "peerId": participant_id}, exclude=participant_id)
