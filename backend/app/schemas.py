from typing import Literal
from pydantic import BaseModel, EmailStr, Field

class RegisterIn(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    email: EmailStr
    password: str = Field(min_length=6, max_length=128)
    role: Literal["student", "faculty"] = "student"


class JoinFacultyIn(BaseModel):
    invite_token: str = Field(min_length=1, max_length=128)

class LoginIn(BaseModel):
    email: EmailStr
    password: str

class VerifyAccountIn(BaseModel):
    otp: str = Field(min_length=6, max_length=6)

class SendResetOtpIn(BaseModel):
    email: EmailStr

class ResetPasswordIn(BaseModel):
    email: EmailStr
    otp: str = Field(min_length=6, max_length=6)
    newPassword: str = Field(min_length=6, max_length=128)

class RefreshTokenIn(BaseModel):
    refreshToken: str | None = None

class ReauthIn(BaseModel):
    password: str

class AnswerIn(BaseModel):
    question_id: int | str
    option_index: int | None = None
    text_answer: str | None = None
    answer: int | str | None = None

class ViolationIn(BaseModel):
    type: str
    metadata: dict = {}

class AIEventIn(BaseModel):
    event_type: str
    confidence: float = Field(ge=0.0, le=1.0)
    metadata: dict = {}


class ExamCreateIn(BaseModel):
    title: str
    duration_minutes: int = Field(gt=0, le=600)
    max_violations: int = Field(default=2, ge=1, le=20)
    require_camera: bool = True
    require_microphone: bool = True

class QuestionCreateIn(BaseModel):
    type: str = "mcq"  # "mcq", "code", "text"
    text: str
    options: list[str] | None = None
    correct_answer: int | None = None
    language: str | None = "python"
    starter_code: str | None = None
    sample_solution: str | None = None
    marks: int = Field(default=1, ge=1)

class GradeAttemptIn(BaseModel):
    grades: dict[str, int] = {}  # { question_id: awarded_marks }
    feedback: str | None = None

class SubjectCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = None

class AIGeneratedQuestion(BaseModel):
    text: str
    options: list[str] = Field(min_length=2, max_length=8)
    correct_answer: int = Field(ge=0)
    marks: int = Field(default=1, ge=1)
    difficulty: str = "medium"

class CreateExamFromQuestionsIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    duration_minutes: int = Field(gt=0, le=600)
    max_violations: int = Field(default=2, ge=1, le=20)
    require_camera: bool = True
    require_microphone: bool = True
    questions: list[AIGeneratedQuestion] = Field(min_length=1)

