import secrets
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from contextlib import asynccontextmanager

from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, Response, Request, status
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorDatabase

from .config import settings
from .db import db, get_db, to_object_id, serialize_doc, ensure_indexes, to_iso_str
from .models import utc_now
from .schemas import (
    RegisterIn,
    LoginIn,
    VerifyAccountIn,
    SendResetOtpIn,
    ResetPasswordIn,
    RefreshTokenIn,
    ReauthIn,
    AnswerIn,
    ViolationIn,
    AIEventIn,
    ExamCreateIn,
    QuestionCreateIn,
    GradeAttemptIn,
    SubjectCreateIn,
    CreateExamFromQuestionsIn,
    JoinFacultyIn,
)
from .auth import (
    hash_password,
    verify_password,
    make_token,
    make_refresh_token,
    generate_otp,
    decode_token,
    current_user,
    admin_user,
    faculty_user,
)
from .email_service import (
    send_welcome_and_otp,
    send_verification_otp,
    send_reset_password_otp,
)
from .proctoring.policy import decide
from .ai_generator import extract_pdf_text, generate_questions as ai_generate


def set_auth_cookies(response: Response, token: str, refresh_token: str):
    response.set_cookie(
        key="token",
        value=token,
        httponly=True,
        secure=False,
        samesite="lax",
        max_age=settings.access_token_minutes * 60,
    )
    response.set_cookie(
        key="refreshToken",
        value=refresh_token,
        httponly=True,
        secure=False,
        samesite="lax",
        max_age=settings.refresh_token_days * 24 * 60 * 60,
    )


def clear_auth_cookies(response: Response):
    response.delete_cookie(key="token")
    response.delete_cookie(key="refreshToken")


def parse_datetime(val: Any) -> datetime | None:
    if val is None:
        return None
    if isinstance(val, datetime):
        return val
    if isinstance(val, str):
        try:
            return datetime.fromisoformat(val.replace("Z", "+00:00"))
        except Exception:
            return None
    return None


def calculate_score(exam: dict[str, Any], answers: dict[str, Any], manual_grades: dict[str, Any] | None = None) -> int:
    score = 0
    questions = exam.get("questions", [])
    if not questions:
        return 0
    manual_grades = manual_grades or {}
    for q in questions:
        qid = str(q.get("id"))
        q_type = q.get("type", "mcq")
        if qid in manual_grades:
            score += int(manual_grades[qid])
        elif q_type == "mcq" and answers:
            if qid in answers and answers[qid] == q.get("correct_answer"):
                score += q.get("marks", 1)
    return score


async def check_and_enforce_expiry(attempt: dict[str, Any], exam: dict[str, Any], database: AsyncIOMotorDatabase) -> bool:
    if attempt.get("status") != "in_progress":
        return False
    now = utc_now()
    started_at = parse_datetime(attempt.get("started_at")) or now
    if started_at.tzinfo is None:
        started_at = started_at.replace(tzinfo=timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)

    allowed_seconds = (int(exam.get("duration_minutes", 60)) * 60) + 60
    elapsed_seconds = (now - started_at).total_seconds()
    if elapsed_seconds > allowed_seconds:
        score = calculate_score(exam, attempt.get("answers") or {})
        attempt_id = attempt.get("id") or attempt.get("_id")
        await database.attempts.update_one(
            {"_id": to_object_id(attempt_id)},
            {
                "$set": {
                    "status": "auto_submitted",
                    "submitted_at": now,
                    "score": score,
                }
            },
        )
        attempt["status"] = "auto_submitted"
        attempt["submitted_at"] = now
        attempt["score"] = score
        return True
    return False


@asynccontextmanager
async def lifespan(app: FastAPI):
    Path(settings.upload_dir).mkdir(parents=True, exist_ok=True)
    await ensure_indexes(db)

    # Seed or sync Admin User
    admin = await db.users.find_one({"email": settings.admin_email.lower()})
    admin_pwd_hash = hash_password(settings.admin_password)
    if not admin:
        await db.users.insert_one(
            {
                "name": "Administrator",
                "email": settings.admin_email.lower(),
                "password": admin_pwd_hash,
                "password_hash": admin_pwd_hash,
                "role": "admin",
                "isAccountVerified": True,
                "verifyOtp": "",
                "verifyOtpExpireAt": 0,
                "resetOtp": "",
                "resetOtpExpireAt": 0,
                "active": True,
                "created_at": utc_now(),
            }
        )
    else:
        await db.users.update_one(
            {"_id": admin["_id"]},
            {"$set": {"password": admin_pwd_hash, "password_hash": admin_pwd_hash, "role": "admin", "isAccountVerified": True}},
        )


    # Seed Student User
    student = await db.users.find_one({"email": settings.student_email.lower()})
    if not student:
        await db.users.insert_one(
            {
                "name": "Demo Student",
                "email": settings.student_email.lower(),
                "password_hash": hash_password(settings.student_password),
                "role": "student",
                "isAccountVerified": True,
                "verifyOtp": "",
                "verifyOtpExpireAt": 0,
                "resetOtp": "",
                "resetOtpExpireAt": 0,
                "active": True,
                "created_at": utc_now(),
            }
        )

    # Seed Demo Exam if none exists
    first_exam = await db.exams.find_one({})
    if not first_exam:
        await db.exams.insert_one(
            {
                "title": "Demo Mathematics Exam",
                "duration_minutes": 30,
                "max_violations": 2,
                "total_marks": 3,
                "active": True,
                "require_camera": True,
                "require_microphone": True,
                "created_at": utc_now(),
                "questions": [
                    {
                        "id": "1",
                        "text": "What is 2 + 2?",
                        "options": ["3", "4", "5", "6"],
                        "correct_answer": 1,
                        "marks": 1,
                    },
                    {
                        "id": "2",
                        "text": "What is 3 × 3?",
                        "options": ["6", "8", "9", "12"],
                        "correct_answer": 2,
                        "marks": 1,
                    },
                    {
                        "id": "3",
                        "text": "Which is a prime number?",
                        "options": ["4", "6", "7", "9"],
                        "correct_answer": 2,
                        "marks": 1,
                    },
                ],
            }
        )

    # Backfill invite_token for existing faculty users that don't have one
    async for fac in db.users.find({"role": "faculty", "invite_token": {"$exists": False}}):
        await db.users.update_one(
            {"_id": fac["_id"]},
            {"$set": {"invite_token": secrets.token_urlsafe(32)}},
        )
    yield


app = FastAPI(title="Secure Exam Portal API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:8001",
        "http://127.0.0.1:8001",
    ],
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)



@app.get("/api/health")
async def health():
    return {"ok": True}


# ─── Authentication (MERN Auth Compatible Flow) ─────────────────────────────────

@app.post("/api/auth/register")
async def register(
    data: RegisterIn,
    response: Response,
    database: AsyncIOMotorDatabase = Depends(get_db),
):
    email_clean = data.email.lower().strip()
    existing = await database.users.find_one({"email": email_clean})
    if existing:
        return {"success": False, "message": "User already exists"}

    otp = generate_otp()
    otp_expire_at = int((datetime.now(timezone.utc).timestamp() + 10 * 60) * 1000)

    role = data.role if data.role in ("student", "faculty") else "student"
    hashed = hash_password(data.password)
    user_doc = {
        "name": data.name.strip(),
        "email": email_clean,
        "password": hashed,
        "password_hash": hashed,
        "role": role,
        "verifyOtp": otp,
        "verifyOtpExpireAt": otp_expire_at,
        "isAccountVerified": False,
        "resetOtp": "",
        "resetOtpExpireAt": 0,
        "refreshToken": "",
        "refreshTokenExpireAt": 0,
        "active": True,
        "created_at": utc_now(),
    }
    if role == "faculty":
        user_doc["invite_token"] = secrets.token_urlsafe(32)

    result = await database.users.insert_one(user_doc)
    user_id = str(result.inserted_id)
    user_doc["id"] = user_id
    user_doc["_id"] = result.inserted_id

    token = make_token(user_doc)
    refresh_token = make_refresh_token(user_doc)
    refresh_expire_at = int((datetime.now(timezone.utc).timestamp() + settings.refresh_token_days * 86400) * 1000)

    await database.users.update_one(
        {"_id": result.inserted_id},
        {"$set": {"refreshToken": refresh_token, "refreshTokenExpireAt": refresh_expire_at}},
    )

    set_auth_cookies(response, token, refresh_token)

    # Send Welcome & Verification OTP Email
    await send_welcome_and_otp(user_doc["name"], email_clean, otp)

    return {
        "success": True,
        "message": "User registered successfully",
        "token": token,
        "refreshToken": refresh_token,
        "access_token": token,
        "user": {
            "id": user_id,
            "name": user_doc["name"],
            "email": user_doc["email"],
            "role": role,
            "isAccountVerified": False,
        },
    }


@app.post("/api/auth/login")
async def login(
    data: LoginIn,
    response: Response,
    database: AsyncIOMotorDatabase = Depends(get_db),
):
    email_clean = data.email.lower().strip()
    user = await database.users.find_one({"email": email_clean})
    stored_hash = str(user.get("password") or user.get("password_hash") or "") if user else ""
    if not user or not verify_password(data.password, stored_hash):
        return {"success": False, "message": "Invalid email or password"}

    user_data = serialize_doc(user)
    token = make_token(user_data)
    refresh_token = make_refresh_token(user_data)
    refresh_expire_at = int((datetime.now(timezone.utc).timestamp() + settings.refresh_token_days * 86400) * 1000)

    await database.users.update_one(
        {"_id": user["_id"]},
        {"$set": {"refreshToken": refresh_token, "refreshTokenExpireAt": refresh_expire_at}},
    )

    set_auth_cookies(response, token, refresh_token)

    return {
        "success": True,
        "message": "Logged in successfully",
        "token": token,
        "refreshToken": refresh_token,
        "access_token": token,
        "user": {
            "id": user_data["id"],
            "name": user_data.get("name", ""),
            "email": user_data.get("email", ""),
            "role": user_data.get("role", "student"),
            "isAccountVerified": user_data.get("isAccountVerified", True),
        },
    }


@app.post("/api/auth/logout")
async def logout(response: Response, user: dict[str, Any] = Depends(current_user), database: AsyncIOMotorDatabase = Depends(get_db)):
    clear_auth_cookies(response)
    try:
        await database.users.update_one({"_id": to_object_id(user["id"])}, {"$set": {"refreshToken": "", "refreshTokenExpireAt": 0}})
    except Exception:
        pass
    return {"success": True, "message": "Logged out successfully"}


@app.post("/api/auth/send-verify-otp")
@app.post("/api/auth/resend-otp")
async def send_verify_otp(user: dict[str, Any] = Depends(current_user), database: AsyncIOMotorDatabase = Depends(get_db)):
    db_user = await database.users.find_one({"_id": to_object_id(user["id"])})
    if not db_user:
        return {"success": False, "message": "User not found"}

    if db_user.get("isAccountVerified", False):
        return {"success": False, "message": "Account is already verified"}

    otp = generate_otp()
    otp_expire_at = int((datetime.now(timezone.utc).timestamp() + 10 * 60) * 1000)

    await database.users.update_one(
        {"_id": db_user["_id"]},
        {"$set": {"verifyOtp": otp, "verifyOtpExpireAt": otp_expire_at}},
    )

    await send_verification_otp(db_user.get("name", "User"), db_user.get("email"), otp)
    return {"success": True, "message": "Verification OTP sent to your email"}


@app.post("/api/auth/verify-account")
async def verify_account(data: VerifyAccountIn, user: dict[str, Any] = Depends(current_user), database: AsyncIOMotorDatabase = Depends(get_db)):
    db_user = await database.users.find_one({"_id": to_object_id(user["id"])})
    if not db_user:
        return {"success": False, "message": "User not found"}

    stored_otp = str(db_user.get("verifyOtp", ""))
    expire_at = db_user.get("verifyOtpExpireAt", 0)
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)

    if not stored_otp or stored_otp != data.otp.strip():
        return {"success": False, "message": "Invalid OTP"}

    if expire_at and expire_at < now_ms:
        return {"success": False, "message": "OTP has expired"}

    await database.users.update_one(
        {"_id": db_user["_id"]},
        {"$set": {"isAccountVerified": True, "verifyOtp": "", "verifyOtpExpireAt": 0}},
    )

    return {"success": True, "message": "Email verified successfully"}


@app.post("/api/auth/send-reset-otp")
async def send_reset_otp(data: SendResetOtpIn, database: AsyncIOMotorDatabase = Depends(get_db)):
    email_clean = data.email.lower().strip()
    db_user = await database.users.find_one({"email": email_clean})
    if not db_user:
        return {"success": False, "message": "No account found with this email"}

    otp = generate_otp()
    otp_expire_at = int((datetime.now(timezone.utc).timestamp() + 15 * 60) * 1000)

    await database.users.update_one(
        {"_id": db_user["_id"]},
        {"$set": {"resetOtp": otp, "resetOtpExpireAt": otp_expire_at}},
    )

    await send_reset_password_otp(db_user.get("name", "User"), email_clean, otp)
    return {"success": True, "message": "Password reset OTP sent to your email"}


@app.post("/api/auth/reset-password")
async def reset_password(data: ResetPasswordIn, database: AsyncIOMotorDatabase = Depends(get_db)):
    email_clean = data.email.lower().strip()
    db_user = await database.users.find_one({"email": email_clean})
    if not db_user:
        return {"success": False, "message": "User not found"}

    stored_otp = str(db_user.get("resetOtp", ""))
    expire_at = db_user.get("resetOtpExpireAt", 0)
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)

    if not stored_otp or stored_otp != data.otp.strip():
        return {"success": False, "message": "Invalid OTP"}

    if expire_at and expire_at < now_ms:
        return {"success": False, "message": "OTP has expired"}

    new_hash = hash_password(data.newPassword)
    await database.users.update_one(
        {"_id": db_user["_id"]},
        {
            "$set": {
                "password": new_hash,
                "password_hash": new_hash,
                "resetOtp": "",
                "resetOtpExpireAt": 0,
            }
        },
    )

    return {"success": True, "message": "Password has been reset successfully"}


@app.post("/api/auth/refresh-token")
async def refresh_token_endpoint(
    request: Request,
    response: Response,
    payload: RefreshTokenIn | None = None,
    database: AsyncIOMotorDatabase = Depends(get_db),
):
    token_str = ""
    if payload and payload.refreshToken:
        token_str = payload.refreshToken
    elif request.cookies.get("refreshToken"):
        token_str = request.cookies.get("refreshToken", "")

    if not token_str:
        return {"success": False, "message": "Refresh token missing"}

    try:
        decoded = decode_token(token_str)
        uid = decoded.get("id") or decoded.get("sub")
    except Exception:
        return {"success": False, "message": "Invalid or expired refresh token"}

    db_user = await database.users.find_one({"_id": to_object_id(uid)})
    if not db_user or db_user.get("refreshToken") != token_str:
        return {"success": False, "message": "Refresh token invalidated"}

    user_data = serialize_doc(db_user)
    new_token = make_token(user_data)
    response.set_cookie(
        key="token",
        value=new_token,
        httponly=True,
        secure=False,
        samesite="lax",
        max_age=settings.access_token_minutes * 60,
    )

    return {"success": True, "token": new_token, "access_token": new_token}


@app.post("/api/auth/is-auth")
@app.get("/api/auth/is-auth")
async def is_authenticated(user: dict[str, Any] = Depends(current_user)):
    return {
        "success": True,
        "authenticated": True,
        "user": user,
    }


@app.get("/api/user/data")
@app.post("/api/user/data")
async def get_user_data(user: dict[str, Any] = Depends(current_user)):
    return {
        "success": True,
        "userData": {
            "id": user.get("id"),
            "name": user.get("name"),
            "email": user.get("email"),
            "role": user.get("role", "student"),
            "isAccountVerified": user.get("isAccountVerified", False),
        },
    }


@app.post("/api/auth/reauth")
async def reauth(data: ReauthIn, user: dict[str, Any] = Depends(current_user), database: AsyncIOMotorDatabase = Depends(get_db)):
    raw_user = await database.users.find_one({"_id": to_object_id(user["id"])})
    stored_hash = str(raw_user.get("password") or raw_user.get("password_hash") or "") if raw_user else ""
    if not raw_user or not verify_password(data.password, stored_hash):
        raise HTTPException(401, "Password verification failed")
    return {"verified": True}


# ─── Exams & Student Flow ────────────────────────────────────────────────────

@app.get("/api/exams")
async def list_exams(user: dict[str, Any] = Depends(current_user), database: AsyncIOMotorDatabase = Depends(get_db)):
    cursor = database.exams.find({"active": True}).sort("created_at", -1)
    exams = await cursor.to_list(100)
    res = []
    for e in exams:
        exam_id_str = str(e["_id"])
        attempt = await database.attempts.find_one(
            {
                "student_id": str(user["id"]),
                "exam_id": {"$in": [exam_id_str, to_object_id(exam_id_str)]},
            },
            sort=[("started_at", -1)],
        )
        res.append(
            {
                "id": exam_id_str,
                "title": e.get("title"),
                "duration_minutes": e.get("duration_minutes", 60),
                "max_violations": e.get("max_violations", 2),
                "require_camera": e.get("require_camera", True),
                "require_microphone": e.get("require_microphone", True),
                "total_marks": e.get("total_marks", 0),
                "attempt": (
                    {
                        "id": str(attempt["_id"]),
                        "status": attempt.get("status"),
                        "score": attempt.get("score", 0),
                    }
                    if attempt
                    else None
                ),
            }
        )
    return res


@app.post("/api/exams/{exam_id}/start")
async def start_exam(
    exam_id: str, user: dict[str, Any] = Depends(current_user), database: AsyncIOMotorDatabase = Depends(get_db)
):
    exam = await database.exams.find_one({"_id": to_object_id(exam_id)})
    if not exam or not exam.get("active", True):
        raise HTTPException(404, "Exam not found")

    existing = await database.attempts.find_one(
        {
            "student_id": str(user["id"]),
            "exam_id": {"$in": [str(exam["_id"]), to_object_id(exam_id)]},
        },
        sort=[("started_at", -1)],
    )

    if existing:
        existing_doc = serialize_doc(existing)
        if existing.get("status") == "in_progress":
            expired = await check_and_enforce_expiry(existing_doc, exam, database)
            if not expired:
                started_dt = parse_datetime(existing.get("started_at")) or utc_now()
                return {
                    "attempt_id": existing_doc["id"],
                    "started_at": to_iso_str(started_dt),
                    "duration_minutes": exam.get("duration_minutes", 60),
                    "status": existing.get("status"),
                }
        raise HTTPException(
            400,
            f"You have already completed an attempt for this exam (Status: {existing.get('status')}).",
        )

    now = utc_now()
    attempt_doc = {
        "student_id": str(user["id"]),
        "exam_id": str(exam["_id"]),
        "status": "in_progress",
        "started_at": now,
        "submitted_at": None,
        "score": 0,
        "answers": {},
    }
    result = await database.attempts.insert_one(attempt_doc)
    attempt_id = str(result.inserted_id)
    return {
        "attempt_id": attempt_id,
        "started_at": to_iso_str(now),
        "duration_minutes": exam.get("duration_minutes", 60),
        "status": "in_progress",
    }


@app.post("/api/attempts/{attempt_id}/start-timer")
async def start_attempt_timer(
    attempt_id: str, user: dict[str, Any] = Depends(current_user), database: AsyncIOMotorDatabase = Depends(get_db)
):
    attempt = await database.attempts.find_one({"_id": to_object_id(attempt_id)})
    if not attempt or str(attempt.get("student_id")) != str(user["id"]):
        raise HTTPException(404, "Attempt not found")
    exam = await database.exams.find_one({"_id": to_object_id(attempt.get("exam_id"))})
    if not exam:
        raise HTTPException(404, "Exam not found")
    if attempt.get("status") != "in_progress":
        raise HTTPException(400, "Attempt is not in progress")

    now = utc_now()
    await database.attempts.update_one(
        {"_id": to_object_id(attempt_id)},
        {"$set": {"started_at": now}},
    )
    return {
        "attempt_id": str(attempt["_id"]),
        "started_at": to_iso_str(now),
        "duration_minutes": exam.get("duration_minutes", 60),
    }


@app.get("/api/attempts/{attempt_id}")
async def get_attempt(
    attempt_id: str, user: dict[str, Any] = Depends(current_user), database: AsyncIOMotorDatabase = Depends(get_db)
):
    attempt = await database.attempts.find_one({"_id": to_object_id(attempt_id)})
    if not attempt or str(attempt.get("student_id")) != str(user["id"]):
        raise HTTPException(404, "Attempt not found")
    exam = await database.exams.find_one({"_id": to_object_id(attempt.get("exam_id"))})
    if not exam:
        raise HTTPException(404, "Exam not found")

    attempt_doc = serialize_doc(attempt)
    await check_and_enforce_expiry(attempt_doc, exam, database)
    started_dt = parse_datetime(attempt_doc.get("started_at")) or utc_now()
    submitted_dt = parse_datetime(attempt_doc.get("submitted_at"))

    questions_out = [
        {
            "id": str(q.get("id")),
            "type": q.get("type", "mcq"),
            "text": q.get("text"),
            "options": q.get("options", []),
            "language": q.get("language", "python"),
            "starter_code": q.get("starter_code", ""),
            "marks": q.get("marks", 1),
        }
        for q in exam.get("questions", [])
    ]

    return {
        "id": attempt_doc["id"],
        "status": attempt_doc.get("status"),
        "started_at": to_iso_str(started_dt),
        "submitted_at": to_iso_str(submitted_dt),
        "score": attempt_doc.get("score", 0),
        "answers": attempt_doc.get("answers") or {},
        "exam": {
            "id": str(exam["_id"]),
            "title": exam.get("title"),
            "duration_minutes": exam.get("duration_minutes", 60),
            "max_violations": exam.get("max_violations", 2),
        },
        "questions": questions_out,
    }


@app.post("/api/attempts/{attempt_id}/answers")
async def save_answer(
    attempt_id: str,
    data: AnswerIn,
    user: dict[str, Any] = Depends(current_user),
    database: AsyncIOMotorDatabase = Depends(get_db),
):
    attempt = await database.attempts.find_one({"_id": to_object_id(attempt_id)})
    if not attempt or str(attempt.get("student_id")) != str(user["id"]):
        raise HTTPException(404, "Attempt not found")
    exam = await database.exams.find_one({"_id": to_object_id(attempt.get("exam_id"))})
    if not exam:
        raise HTTPException(404, "Exam not found")

    attempt_doc = serialize_doc(attempt)
    if await check_and_enforce_expiry(attempt_doc, exam, database) or attempt.get("status") != "in_progress":
        raise HTTPException(400, "Exam time has expired or attempt is submitted")

    answers = dict(attempt.get("answers") or {})
    answer_val = data.answer
    if answer_val is None:
        if data.text_answer is not None:
            answer_val = data.text_answer
        elif data.option_index is not None:
            answer_val = data.option_index
    answers[str(data.question_id)] = answer_val

    await database.attempts.update_one(
        {"_id": to_object_id(attempt_id)},
        {"$set": {"answers": answers}},
    )
    return {"saved": True, "answers": answers}


@app.post("/api/attempts/{attempt_id}/violations")
async def violation(
    attempt_id: str,
    data: ViolationIn,
    user: dict[str, Any] = Depends(current_user),
    database: AsyncIOMotorDatabase = Depends(get_db),
):
    attempt = await database.attempts.find_one({"_id": to_object_id(attempt_id)})
    if not attempt or str(attempt.get("student_id")) != str(user["id"]):
        raise HTTPException(404, "Attempt not found")
    exam = await database.exams.find_one({"_id": to_object_id(attempt.get("exam_id"))})
    if not exam:
        raise HTTPException(404, "Exam not found")

    attempt_doc = serialize_doc(attempt)
    if await check_and_enforce_expiry(attempt_doc, exam, database) or attempt.get("status") != "in_progress":
        raise HTTPException(400, "Attempt unavailable or time expired")

    now = utc_now()
    v_doc = {
        "attempt_id": str(attempt["_id"]),
        "type": data.type,
        "severity": "warning",
        "metadata_json": data.metadata,
        "created_at": now,
    }
    await database.violations.insert_one(v_doc)

    count = await database.violations.count_documents({
        "attempt_id": {"$in": [str(attempt["_id"]), to_object_id(attempt_id)]}
    })
    auto = count >= int(exam.get("max_violations", 2))
    if auto:
        score = calculate_score(exam, attempt.get("answers") or {})
        await database.attempts.update_one(
            {"_id": to_object_id(attempt_id)},
            {
                "$set": {
                    "status": "auto_submitted",
                    "submitted_at": now,
                    "score": score,
                }
            },
        )
        await database.violations.update_one(
            {"_id": v_doc.get("_id")},
            {"$set": {"severity": "auto_submit"}},
        )

    return {
        "violation_count": count,
        "max_violations": exam.get("max_violations", 2),
        "auto_submitted": auto,
    }


@app.post("/api/attempts/{attempt_id}/ai-event")
async def ai_event(
    attempt_id: str,
    data: AIEventIn,
    user: dict[str, Any] = Depends(current_user),
    database: AsyncIOMotorDatabase = Depends(get_db),
):
    attempt = await database.attempts.find_one({"_id": to_object_id(attempt_id)})
    if not attempt or str(attempt.get("student_id")) != str(user["id"]):
        raise HTTPException(404, "Attempt not found")
    exam = await database.exams.find_one({"_id": to_object_id(attempt.get("exam_id"))})
    if not exam:
        raise HTTPException(404, "Exam not found")

    attempt_doc = serialize_doc(attempt)
    if await check_and_enforce_expiry(attempt_doc, exam, database) or attempt.get("status") != "in_progress":
        raise HTTPException(400, "Attempt unavailable or time expired")

    decision = decide(data.event_type, data.confidence)
    violation_logged = False
    now = utc_now()

    if decision.action in ("flag", "high_review"):
        v_doc = {
            "attempt_id": str(attempt["_id"]),
            "type": f"AI_{data.event_type}",
            "severity": decision.action,
            "metadata_json": {
                "confidence": data.confidence,
                "reason": decision.reason,
                **data.metadata,
            },
            "created_at": now,
        }
        await database.violations.insert_one(v_doc)
        violation_logged = True

    total_count = await database.violations.count_documents({
        "attempt_id": {"$in": [str(attempt["_id"]), to_object_id(attempt_id)]}
    })

    auto = total_count >= int(exam.get("max_violations", 2))
    if auto:
        score = calculate_score(exam, attempt.get("answers") or {})
        await database.attempts.update_one(
            {"_id": to_object_id(attempt_id)},
            {
                "$set": {
                    "status": "auto_submitted",
                    "submitted_at": now,
                    "score": score,
                }
            },
        )

    return {
        "action": decision.action,
        "reason": decision.reason,
        "violation_logged": violation_logged,
        "violation_count": total_count,
        "max_violations": exam.get("max_violations", 2),
        "auto_submitted": auto,
    }


@app.post("/api/attempts/{attempt_id}/submit")
async def submit(
    attempt_id: str, user: dict[str, Any] = Depends(current_user), database: AsyncIOMotorDatabase = Depends(get_db)
):
    attempt = await database.attempts.find_one({"_id": to_object_id(attempt_id)})
    if not attempt or str(attempt.get("student_id")) != str(user["id"]):
        raise HTTPException(404, "Attempt not found")
    exam = await database.exams.find_one({"_id": to_object_id(attempt.get("exam_id"))})
    if not exam:
        raise HTTPException(404, "Exam not found")

    status_val = attempt.get("status")
    score_val = attempt.get("score", 0)
    if status_val == "in_progress":
        score_val = calculate_score(exam, attempt.get("answers") or {})
        status_val = "submitted"
        now = utc_now()
        await database.attempts.update_one(
            {"_id": to_object_id(attempt_id)},
            {
                "$set": {
                    "status": status_val,
                    "score": score_val,
                    "submitted_at": now,
                }
            },
        )
    return {"status": status_val, "score": score_val}


@app.post("/api/attempts/{attempt_id}/rough-work")
async def rough_work(
    attempt_id: str,
    skipped: bool = False,
    file: UploadFile | None = File(default=None),
    user: dict[str, Any] = Depends(current_user),
    database: AsyncIOMotorDatabase = Depends(get_db),
):
    attempt = await database.attempts.find_one({"_id": to_object_id(attempt_id)})
    if not attempt or str(attempt.get("student_id")) != str(user["id"]):
        raise HTTPException(404, "Attempt not found")
    if attempt.get("status") not in ("submitted", "auto_submitted"):
        raise HTTPException(400, "Rough work is available after submission")

    existing = await database.rough_work.find_one({
        "attempt_id": {"$in": [str(attempt["_id"]), to_object_id(attempt_id)]}
    })
    if existing:
        raise HTTPException(409, "Rough work already recorded")

    now = utc_now()
    if skipped:
        rw_doc = {
            "attempt_id": str(attempt["_id"]),
            "skipped": True,
            "file_name": None,
            "file_path": None,
            "uploaded_at": now,
        }
        await database.rough_work.insert_one(rw_doc)
        return {"skipped": True}

    if not file or not file.filename:
        raise HTTPException(400, "Choose a file or skip")

    ext = Path(file.filename).suffix.lower()
    allowed_exts = {".pdf", ".jpg", ".jpeg", ".png"}
    allowed_mimes = {"application/pdf", "image/jpeg", "image/png"}

    if ext not in allowed_exts or file.content_type not in allowed_mimes:
        raise HTTPException(400, "Only PDF, JPG, JPEG or PNG files are allowed")

    data = await file.read()
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(413, "File too large")

    safe_name = f"{attempt_id}-{uuid.uuid4().hex}{ext}"
    upload_path = Path(settings.upload_dir)
    upload_path.mkdir(parents=True, exist_ok=True)
    path = upload_path / safe_name
    path.write_bytes(data)

    rw_doc = {
        "attempt_id": str(attempt["_id"]),
        "skipped": False,
        "file_name": file.filename,
        "file_path": str(path),
        "uploaded_at": now,
    }
    await database.rough_work.insert_one(rw_doc)
    return {"uploaded": True, "file_name": file.filename}


# ─── Admin Management ────────────────────────────────────────────────────────

@app.get("/api/admin/exams")
async def admin_list_exams(_: dict[str, Any] = Depends(admin_user), database: AsyncIOMotorDatabase = Depends(get_db)):
    cursor = database.exams.find({}).sort("created_at", -1)
    exams = await cursor.to_list(200)
    return [
        {
            "id": str(e["_id"]),
            "title": e.get("title"),
            "duration_minutes": e.get("duration_minutes", 60),
            "max_violations": e.get("max_violations", 2),
            "total_marks": e.get("total_marks", 0),
            "active": e.get("active", True),
            "questions": [
                {
                    "id": str(q.get("id")),
                    "type": q.get("type", "mcq"),
                    "text": q.get("text"),
                    "options": q.get("options", []),
                    "correct_answer": q.get("correct_answer"),
                    "language": q.get("language", "python"),
                    "starter_code": q.get("starter_code", ""),
                    "sample_solution": q.get("sample_solution", ""),
                    "marks": q.get("marks", 1),
                }
                for q in e.get("questions", [])
            ],
        }
        for e in exams
    ]


@app.post("/api/admin/exams")
async def create_exam(
    data: ExamCreateIn, _: dict[str, Any] = Depends(admin_user), database: AsyncIOMotorDatabase = Depends(get_db)
):
    exam_doc = {
        "title": data.title,
        "duration_minutes": data.duration_minutes,
        "max_violations": data.max_violations,
        "require_camera": data.require_camera,
        "require_microphone": data.require_microphone,
        "total_marks": 0,
        "active": True,
        "created_at": utc_now(),
        "questions": [],
    }
    res = await database.exams.insert_one(exam_doc)
    return {"id": str(res.inserted_id), "title": data.title}


@app.post("/api/admin/exams/{exam_id}/questions")
async def create_question(
    exam_id: str,
    data: QuestionCreateIn,
    _: dict[str, Any] = Depends(admin_user),
    database: AsyncIOMotorDatabase = Depends(get_db),
):
    exam = await database.exams.find_one({"_id": to_object_id(exam_id)})
    if not exam:
        raise HTTPException(404, "Exam not found")
    
    q_type = data.type or "mcq"
    if q_type == "mcq":
        if not data.options or len(data.options) < 2:
            raise HTTPException(400, "MCQ questions must have at least 2 options")
        if data.correct_answer is None or data.correct_answer >= len(data.options):
            raise HTTPException(400, "correct_answer is outside options")

    existing_questions = exam.get("questions", [])
    new_q_id = str(len(existing_questions) + 1)
    new_q: dict[str, Any] = {
        "id": new_q_id,
        "type": q_type,
        "text": data.text,
        "marks": data.marks,
    }
    if q_type == "mcq":
        new_q["options"] = data.options or []
        new_q["correct_answer"] = data.correct_answer
    else:
        new_q["language"] = data.language or "python"
        new_q["starter_code"] = data.starter_code or ""
        new_q["sample_solution"] = data.sample_solution or ""

    new_total_marks = int(exam.get("total_marks", 0)) + data.marks
    await database.exams.update_one(
        {"_id": to_object_id(exam_id)},
        {
            "$push": {"questions": new_q},
            "$set": {"total_marks": new_total_marks},
        },
    )
    return {"id": new_q_id, "text": data.text, "type": q_type}


@app.get("/api/admin/attempts")
async def admin_attempts(_: dict[str, Any] = Depends(admin_user), database: AsyncIOMotorDatabase = Depends(get_db)):
    cursor = database.attempts.find({}).sort("started_at", -1).limit(200)
    rows = await cursor.to_list(200)
    results = []
    for a in rows:
        attempt_id_str = str(a["_id"])
        student_id_val = a.get("student_id")
        exam_id_val = a.get("exam_id")

        student = await database.users.find_one({"_id": to_object_id(student_id_val)})
        exam = await database.exams.find_one({"_id": to_object_id(exam_id_val)})
        
        v_cursor = database.violations.find({
            "attempt_id": {"$in": [attempt_id_str, to_object_id(attempt_id_str)]}
        })
        violations = await v_cursor.to_list(100)
        
        rough = await database.rough_work.find_one({
            "attempt_id": {"$in": [attempt_id_str, to_object_id(attempt_id_str)]}
        })

        started_dt = parse_datetime(a.get("started_at"))
        submitted_dt = parse_datetime(a.get("submitted_at"))

        results.append(
            {
                "id": attempt_id_str,
                "student": {
                    "id": str(student["_id"]) if student else None,
                    "name": student.get("name") if student else "Unknown",
                    "email": student.get("email") if student else "Unknown",
                },
                "exam": {
                    "id": str(exam["_id"]) if exam else None,
                    "title": exam.get("title") if exam else "Unknown Exam",
                    "total_marks": exam.get("total_marks", 0) if exam else 0,
                    "questions": [
                        {
                            "id": str(q.get("id")),
                            "type": q.get("type", "mcq"),
                            "text": q.get("text"),
                            "options": q.get("options", []),
                            "correct_answer": q.get("correct_answer"),
                            "language": q.get("language", "python"),
                            "starter_code": q.get("starter_code", ""),
                            "sample_solution": q.get("sample_solution", ""),
                            "marks": q.get("marks", 1),
                        }
                        for q in (exam.get("questions", []) if exam else [])
                    ],
                },
                "status": a.get("status"),
                "score": a.get("score", 0),
                "answers": a.get("answers") or {},
                "manual_grades": a.get("manual_grades") or {},
                "feedback": a.get("feedback") or "",
                "started_at": to_iso_str(started_dt),
                "submitted_at": to_iso_str(submitted_dt),
                "violations": [
                    {
                        "id": str(v["_id"]),
                        "type": v.get("type"),
                        "severity": v.get("severity"),
                        "metadata": v.get("metadata_json") or {},
                        "created_at": to_iso_str(parse_datetime(v.get("created_at"))),
                    }
                    for v in violations
                ],
                "rough_work": (
                    {
                        "id": str(rough["_id"]),
                        "skipped": rough.get("skipped", False),
                        "file_name": rough.get("file_name"),
                        "uploaded_at": to_iso_str(parse_datetime(rough.get("uploaded_at"))),
                    }
                    if rough
                    else None
                ),
            }
        )
    return results


@app.post("/api/admin/attempts/{attempt_id}/grade")
async def grade_attempt(
    attempt_id: str,
    data: GradeAttemptIn,
    _: dict[str, Any] = Depends(admin_user),
    database: AsyncIOMotorDatabase = Depends(get_db),
):
    attempt = await database.attempts.find_one({"_id": to_object_id(attempt_id)})
    if not attempt:
        raise HTTPException(404, "Attempt not found")
    exam = await database.exams.find_one({"_id": to_object_id(attempt.get("exam_id"))})
    if not exam:
        raise HTTPException(404, "Exam not found")

    manual_grades = dict(attempt.get("manual_grades") or {})
    manual_grades.update(data.grades)

    new_score = calculate_score(exam, attempt.get("answers") or {}, manual_grades)
    
    update_fields: dict[str, Any] = {
        "manual_grades": manual_grades,
        "score": new_score,
    }
    if data.feedback is not None:
        update_fields["feedback"] = data.feedback

    await database.attempts.update_one(
        {"_id": to_object_id(attempt_id)},
        {"$set": update_fields},
    )
    return {"id": attempt_id, "score": new_score, "manual_grades": manual_grades, "feedback": data.feedback}


@app.get("/api/admin/rough-work/{rough_work_id}/download")
async def download_rough_work(
    rough_work_id: str,
    _: dict[str, Any] = Depends(admin_user),
    database: AsyncIOMotorDatabase = Depends(get_db),
):
    rw = await database.rough_work.find_one({"_id": to_object_id(rough_work_id)})
    if not rw or rw.get("skipped") or not rw.get("file_path"):
        raise HTTPException(404, "Rough work file not found")
    path = Path(rw["file_path"])
    if not path.is_file():
        raise HTTPException(404, "File missing on server")
    return FileResponse(
        path=path,
        filename=rw.get("file_name") or path.name,
        media_type="application/octet-stream",
    )


async def _delete_attempt_cascade(attempt_id: str, database: AsyncIOMotorDatabase):
    """Delete an attempt and all its related violations, rough-work, and uploaded files."""
    query_target = {"$in": [attempt_id, to_object_id(attempt_id)]}

    # Delete rough work (and file on disk)
    rough = await database.rough_work.find_one({"attempt_id": query_target})
    if rough:
        if rough.get("file_path"):
            p = Path(rough["file_path"])
            if p.is_file():
                p.unlink(missing_ok=True)
        await database.rough_work.delete_one({"_id": rough["_id"]})

    # Delete violations
    await database.violations.delete_many({"attempt_id": query_target})

    # Delete attempt
    await database.attempts.delete_one({"_id": to_object_id(attempt_id)})


@app.delete("/api/admin/exams/{exam_id}")
async def delete_exam(
    exam_id: str, _: dict[str, Any] = Depends(admin_user), database: AsyncIOMotorDatabase = Depends(get_db)
):
    exam = await database.exams.find_one({"_id": to_object_id(exam_id)})
    if not exam:
        raise HTTPException(404, "Exam not found")

    exam_id_str = str(exam["_id"])
    cursor = database.attempts.find({"exam_id": {"$in": [exam_id_str, to_object_id(exam_id_str)]}})
    attempts = await cursor.to_list(1000)
    for a in attempts:
        await _delete_attempt_cascade(str(a["_id"]), database)

    await database.exams.delete_one({"_id": to_object_id(exam_id)})
    return {"deleted": True, "exam_id": exam_id}


@app.delete("/api/admin/attempts/{attempt_id}")
async def delete_attempt(
    attempt_id: str, _: dict[str, Any] = Depends(admin_user), database: AsyncIOMotorDatabase = Depends(get_db)
):
    attempt = await database.attempts.find_one({"_id": to_object_id(attempt_id)})
    if not attempt:
        raise HTTPException(404, "Attempt not found")
    await _delete_attempt_cascade(attempt_id, database)
    return {"deleted": True, "attempt_id": attempt_id}


@app.post("/api/admin/attempts/{attempt_id}/grant-reattempt")
async def grant_reattempt(
    attempt_id: str, _: dict[str, Any] = Depends(admin_user), database: AsyncIOMotorDatabase = Depends(get_db)
):
    attempt = await database.attempts.find_one({"_id": to_object_id(attempt_id)})
    if not attempt:
        raise HTTPException(404, "Attempt not found")
    student = await database.users.find_one({"_id": to_object_id(attempt.get("student_id"))})
    exam = await database.exams.find_one({"_id": to_object_id(attempt.get("exam_id"))})
    student_name = student.get("name") if student else "Student"
    exam_title = exam.get("title") if exam else "Exam"

    await _delete_attempt_cascade(attempt_id, database)

    return {
        "granted": True,
        "student_name": student_name,
        "exam_title": exam_title,
        "message": f"Granted an additional exam attempt for {student_name} on '{exam_title}'.",
    }


# ─── Subject Management ──────────────────────────────────────────────────────

@app.get("/api/admin/subjects")
async def admin_list_subjects(_: dict[str, Any] = Depends(admin_user), database: AsyncIOMotorDatabase = Depends(get_db)):
    cursor = database.subjects.find({}).sort("name", 1)
    subjects = await cursor.to_list(200)
    return [
        {
            "id": str(s["_id"]),
            "name": s.get("name"),
            "description": s.get("description"),
            "created_at": to_iso_str(parse_datetime(s.get("created_at"))),
        }
        for s in subjects
    ]


@app.post("/api/admin/subjects")
async def create_subject(
    data: SubjectCreateIn, _: dict[str, Any] = Depends(admin_user), database: AsyncIOMotorDatabase = Depends(get_db)
):
    existing = await database.subjects.find_one({"name": data.name})
    if existing:
        raise HTTPException(409, "A subject with this name already exists")
    s_doc = {
        "name": data.name,
        "description": data.description,
        "created_at": utc_now(),
    }
    res = await database.subjects.insert_one(s_doc)
    return {"id": str(res.inserted_id), "name": data.name, "description": data.description}


@app.delete("/api/admin/subjects/{subject_id}")
async def delete_subject(
    subject_id: str, _: dict[str, Any] = Depends(admin_user), database: AsyncIOMotorDatabase = Depends(get_db)
):
    s = await database.subjects.find_one({"_id": to_object_id(subject_id)})
    if not s:
        raise HTTPException(404, "Subject not found")
    await database.subjects.delete_one({"_id": to_object_id(subject_id)})
    return {"deleted": True, "subject_id": subject_id}


# ─── AI Syllabus → Exam Generator ────────────────────────────────────────────

@app.post("/api/admin/ai/analyze-syllabus")
async def analyze_syllabus(
    file: UploadFile = File(...),
    num_questions: int = 10,
    subject_hint: str = "",
    _: dict[str, Any] = Depends(admin_user),
):
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Only PDF files are supported")

    content_type = file.content_type or ""
    if content_type not in ("application/pdf", "application/octet-stream", ""):
        if "pdf" not in content_type:
            raise HTTPException(400, "Only PDF files are supported")

    data = await file.read()
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(413, f"File exceeds {settings.max_upload_mb} MB limit")

    if len(data) == 0:
        raise HTTPException(400, "Uploaded file is empty")

    num_questions = max(1, min(num_questions, 50))

    try:
        text = extract_pdf_text(data)
    except Exception as e:
        raise HTTPException(422, f"Could not extract text from PDF: {e}")

    if len(text.strip()) < 100:
        raise HTTPException(
            422,
            "PDF contains very little extractable text. "
            "Try a text-based PDF rather than a scanned image.",
        )

    try:
        questions = ai_generate(
            api_key=settings.gemini_api_key,
            syllabus_text=text,
            num_questions=num_questions,
            subject_hint=subject_hint,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(502, f"AI generation failed: {e}")

    return {
        "questions": questions,
        "text_length": len(text),
        "pages_processed": text.count("\n\n") + 1,
    }


@app.post("/api/admin/ai/create-exam-from-questions")
async def create_exam_from_questions(
    data: CreateExamFromQuestionsIn,
    _: dict[str, Any] = Depends(admin_user),
    database: AsyncIOMotorDatabase = Depends(get_db),
):
    total_marks = sum(q.marks for q in data.questions)
    formatted_questions = []
    for idx, q in enumerate(data.questions, start=1):
        corr = q.correct_answer if q.correct_answer < len(q.options) else 0
        formatted_questions.append(
            {
                "id": str(idx),
                "text": q.text,
                "options": q.options,
                "correct_answer": corr,
                "marks": q.marks,
            }
        )

    exam_doc = {
        "title": data.title,
        "duration_minutes": data.duration_minutes,
        "max_violations": data.max_violations,
        "require_camera": data.require_camera,
        "require_microphone": data.require_microphone,
        "total_marks": total_marks,
        "active": True,
        "created_at": utc_now(),
        "questions": formatted_questions,
    }
    result = await database.exams.insert_one(exam_doc)
    exam_id = str(result.inserted_id)
    return {
        "exam_id": exam_id,
        "title": data.title,
        "total_marks": total_marks,
        "question_count": len(data.questions),
    }


# ─── Faculty Invite & Student Join ───────────────────────────────────────────

@app.get("/api/faculty/invite")
async def get_faculty_invite(
    user: dict[str, Any] = Depends(faculty_user),
    database: AsyncIOMotorDatabase = Depends(get_db),
):
    db_user = await database.users.find_one({"_id": to_object_id(user["id"])})
    if not db_user:
        raise HTTPException(404, "User not found")
    invite_token = db_user.get("invite_token")
    if not invite_token:
        invite_token = secrets.token_urlsafe(32)
        await database.users.update_one(
            {"_id": db_user["_id"]}, {"$set": {"invite_token": invite_token}}
        )
    return {"invite_token": invite_token}


@app.post("/api/faculty/invite/regenerate")
async def regenerate_invite(
    user: dict[str, Any] = Depends(faculty_user),
    database: AsyncIOMotorDatabase = Depends(get_db),
):
    new_token = secrets.token_urlsafe(32)
    result = await database.users.update_one(
        {"_id": to_object_id(user["id"])}, {"$set": {"invite_token": new_token}}
    )
    if result.modified_count == 0:
        raise HTTPException(500, "Failed to regenerate invite token")
    return {"invite_token": new_token}


@app.get("/api/faculty/students")
async def get_faculty_students(
    user: dict[str, Any] = Depends(faculty_user),
    database: AsyncIOMotorDatabase = Depends(get_db),
):
    faculty_id = str(user["id"])
    cursor = database.faculty_students.find(
        {"faculty_id": faculty_id, "active": True}
    ).sort("joined_at", -1)
    memberships = await cursor.to_list(500)

    students = []
    for m in memberships:
        student = await database.users.find_one({"_id": to_object_id(m["student_id"])})
        if student:
            students.append({
                "id": str(student["_id"]),
                "name": student.get("name", ""),
                "email": student.get("email", ""),
                "joined_at": to_iso_str(parse_datetime(m.get("joined_at"))),
            })
    return {"students": students}


@app.post("/api/student/join-faculty")
async def join_faculty(
    data: JoinFacultyIn,
    user: dict[str, Any] = Depends(current_user),
    database: AsyncIOMotorDatabase = Depends(get_db),
):
    if user.get("role") != "student":
        raise HTTPException(403, "Only students can join faculties")

    token_str = data.invite_token.strip()
    # Support pasting full URL — extract token from path like /join/TOKEN or #/join/TOKEN
    if "/" in token_str:
        parts = token_str.rstrip("/").split("/")
        token_str = parts[-1]

    faculty = await database.users.find_one(
        {"invite_token": token_str, "role": "faculty", "active": True}
    )
    if not faculty:
        raise HTTPException(404, "Invalid or expired invite link")

    faculty_id = str(faculty["_id"])
    student_id = str(user["id"])

    # Prevent self-join (shouldn't happen since roles differ, but defense in depth)
    if faculty_id == student_id:
        raise HTTPException(400, "Cannot join yourself")

    # Check duplicate membership
    existing = await database.faculty_students.find_one(
        {"faculty_id": faculty_id, "student_id": student_id}
    )
    if existing:
        if existing.get("active", True):
            raise HTTPException(409, "You have already joined this faculty")
        # Reactivate if previously deactivated
        await database.faculty_students.update_one(
            {"_id": existing["_id"]},
            {"$set": {"active": True, "joined_at": utc_now()}},
        )
        return {
            "success": True,
            "message": f"Rejoined {faculty.get('name', 'Faculty')}",
            "faculty_name": faculty.get("name", ""),
        }

    await database.faculty_students.insert_one({
        "faculty_id": faculty_id,
        "student_id": student_id,
        "joined_at": utc_now(),
        "active": True,
    })
    return {
        "success": True,
        "message": f"Successfully joined {faculty.get('name', 'Faculty')}",
        "faculty_name": faculty.get("name", ""),
    }


@app.get("/api/student/faculties")
async def get_student_faculties(
    user: dict[str, Any] = Depends(current_user),
    database: AsyncIOMotorDatabase = Depends(get_db),
):
    if user.get("role") != "student":
        raise HTTPException(403, "Only students can view their faculties")

    student_id = str(user["id"])
    cursor = database.faculty_students.find(
        {"student_id": student_id, "active": True}
    ).sort("joined_at", -1)
    memberships = await cursor.to_list(100)

    faculties = []
    for m in memberships:
        fac = await database.users.find_one({"_id": to_object_id(m["faculty_id"])})
        if fac:
            faculties.append({
                "id": str(fac["_id"]),
                "name": fac.get("name", ""),
                "email": fac.get("email", ""),
                "joined_at": to_iso_str(parse_datetime(m.get("joined_at"))),
            })
    return {"faculties": faculties}


@app.get("/api/invite/{invite_token}/info")
async def invite_info(
    invite_token: str,
    user: dict[str, Any] = Depends(current_user),
    database: AsyncIOMotorDatabase = Depends(get_db),
):
    faculty = await database.users.find_one(
        {"invite_token": invite_token, "role": "faculty", "active": True}
    )
    if not faculty:
        raise HTTPException(404, "Invalid or expired invite link")

    faculty_id = str(faculty["_id"])
    student_id = str(user["id"])
    already_joined = False
    if user.get("role") == "student":
        existing = await database.faculty_students.find_one(
            {"faculty_id": faculty_id, "student_id": student_id, "active": True}
        )
        already_joined = existing is not None

    return {
        "faculty_name": faculty.get("name", ""),
        "faculty_email": faculty.get("email", ""),
        "already_joined": already_joined,
        "user_role": user.get("role", ""),
    }
