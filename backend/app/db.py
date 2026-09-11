from typing import Any
from datetime import datetime
from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
from .config import settings

client = AsyncIOMotorClient(settings.mongodb_url)
db = client[settings.mongodb_db_name]


def get_db() -> AsyncIOMotorDatabase:
    return db


def to_object_id(id_val: str | ObjectId | int | None) -> Any:
    if id_val is None:
        return None
    if isinstance(id_val, ObjectId):
        return id_val
    if isinstance(id_val, str) and ObjectId.is_valid(id_val):
        return ObjectId(id_val)
    return id_val


def serialize_doc(doc: dict) -> dict:
    res = dict(doc)
    if "_id" in res:
        res["id"] = str(res["_id"])
        del res["_id"]
    return res


def to_iso_str(val: Any) -> str | None:
    if val is None:
        return None
    if isinstance(val, datetime):
        return val.isoformat()
    if isinstance(val, str):
        return val
    return str(val)

# storing data of a student during exam attempt, which can be used for analysis and review later
async def ensure_indexes(database: AsyncIOMotorDatabase | None = None):      
    target_db = database if database is not None else db
    await target_db.users.create_index("email", unique=True)
    await target_db.users.create_index("invite_token", unique=True, sparse=True)
    await target_db.subjects.create_index("name", unique=True)
    await target_db.attempts.create_index([("student_id", 1), ("exam_id", 1)])
    await target_db.violations.create_index("attempt_id")
    await target_db.rough_work.create_index("attempt_id", unique=True)
    await target_db.faculty_students.create_index(
        [("faculty_id", 1), ("student_id", 1)], unique=True
    )
