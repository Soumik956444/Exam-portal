import random
from datetime import datetime, timedelta, timezone
from typing import Any
import jwt
import bcrypt
from argon2 import PasswordHasher
from fastapi import Depends, HTTPException, Request, status
from motor.motor_asyncio import AsyncIOMotorDatabase
from .config import settings
from .db import get_db, to_object_id, serialize_doc

ph = PasswordHasher()


def hash_password(password: str) -> str:
    salt = bcrypt.gensalt(10)
    return bcrypt.hashpw(password.encode("utf-8"), salt).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    if not password_hash:
        return False
    # Check bcrypt hash (standard for MERN stack)
    if password_hash.startswith(("$2a$", "$2b$", "$2y$")):
        try:
            return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
        except Exception:
            return False
    # Check Argon2 hash
    try:
        return ph.verify(password_hash, password)
    except Exception:
        # Fallback check for plain text legacy mocks
        return password == password_hash



def generate_otp() -> str:
    return f"{random.randint(100000, 999999):06d}"


def make_token(user: dict[str, Any], expires_minutes: int | None = None) -> str:
    user_id = str(user.get("id") or user.get("_id"))
    role = str(user.get("role", "student"))
    exp_mins = expires_minutes or settings.access_token_minutes
    exp = datetime.now(timezone.utc) + timedelta(minutes=exp_mins)
    payload = {
        "id": user_id,
        "sub": user_id,
        "role": role,
        "exp": exp,
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def make_refresh_token(user: dict[str, Any], expires_days: int | None = None) -> str:
    user_id = str(user.get("id") or user.get("_id"))
    exp_days = expires_days or settings.refresh_token_days
    exp = datetime.now(timezone.utc) + timedelta(days=exp_days)
    payload = {
        "id": user_id,
        "sub": user_id,
        "exp": exp,
        "type": "refresh",
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def decode_token(token: str) -> dict[str, Any]:
    return jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])


async def get_token_from_request(request: Request) -> str:
    # 1. Check Authorization header
    auth_header = request.headers.get("Authorization")
    if auth_header and auth_header.startswith("Bearer "):
        return auth_header.split(" ", 1)[1].strip()

    # 2. Check token cookie
    cookie_token = request.cookies.get("token")
    if cookie_token:
        return cookie_token

    # 3. Check query param for WebSockets / downloads
    query_token = request.query_params.get("token")
    if query_token:
        return query_token

    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")


async def current_user(request: Request, db: AsyncIOMotorDatabase = Depends(get_db)) -> dict[str, Any]:
    token = await get_token_from_request(request)
    try:
        payload = decode_token(token)
        uid = str(payload.get("id") or payload.get("sub"))
    except Exception:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")

    query_id = to_object_id(uid)
    user = await db.users.find_one({"_id": query_id})
    if not user or not user.get("active", True):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Account unavailable")

    serialized = serialize_doc(user)
    # Ensure default fields exist
    serialized.setdefault("name", user.get("name") or serialized.get("email", "").split("@")[0])
    serialized.setdefault("isAccountVerified", user.get("isAccountVerified", True))
    serialized.setdefault("role", user.get("role", "student"))
    return serialized


async def admin_user(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if user.get("role") not in ("admin", "proctor"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return user


async def faculty_user(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if user.get("role") != "faculty":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Faculty access required")
    return user
