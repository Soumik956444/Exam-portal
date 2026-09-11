import io
import uuid
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.config import settings


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_health(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_auth_flow(client):
    # Login admin
    res = client.post("/api/auth/login", json={"email": settings.admin_email, "password": settings.admin_password})
    assert res.status_code == 200
    admin_token = res.json()["access_token"]
    assert res.json()["user"]["role"] == "admin"


    # Login student
    res = client.post("/api/auth/login", json={"email": "student@example.com", "password": "ChangeMe123!"})
    assert res.status_code == 200
    student_token = res.json()["access_token"]
    assert res.json()["user"]["role"] == "student"

    # Reauth correct
    res = client.post("/api/auth/reauth", json={"password": "ChangeMe123!"}, headers={"Authorization": f"Bearer {student_token}"})
    assert res.status_code == 200
    assert res.json() == {"verified": True}

    # Reauth wrong
    res = client.post("/api/auth/reauth", json={"password": "wrongpassword"}, headers={"Authorization": f"Bearer {student_token}"})
    assert res.status_code == 401


def test_exam_and_violation_flow(client):
    # Login student
    res = client.post("/api/auth/login", json={"email": "student@example.com", "password": "ChangeMe123!"})
    student_token = res.json()["access_token"]
    headers = {"Authorization": f"Bearer {student_token}"}

    # Admin setup test exam
    admin_res = client.post("/api/auth/login", json={"email": settings.admin_email, "password": settings.admin_password})
    admin_headers = {"Authorization": f"Bearer {admin_res.json()['access_token']}"}
    exam_res = client.post("/api/admin/exams", json={"title": "Test Flow Exam", "duration_minutes": 30, "max_violations": 2}, headers=admin_headers)
    exam_id = exam_res.json()["id"]
    client.post(f"/api/admin/exams/{exam_id}/questions", json={"text": "Q1", "options": ["A", "B", "C", "D"], "correct_answer": 1, "marks": 1}, headers=admin_headers)
    client.post(f"/api/admin/exams/{exam_id}/questions", json={"text": "Q2", "options": ["A", "B", "C", "D"], "correct_answer": 2, "marks": 1}, headers=admin_headers)

    alice_email = f"alice_{uuid.uuid4().hex[:6]}@example.com"
    res = client.post("/api/auth/register", json={"name": "Alice Test", "email": alice_email, "password": "Password123!"})
    alice_token = res.json()["access_token"]
    alice_headers = {"Authorization": f"Bearer {alice_token}"}

    # Start exam
    res = client.post(f"/api/exams/{exam_id}/start", headers=alice_headers)
    assert res.status_code == 200
    attempt_id = res.json()["attempt_id"]

    # Start timer
    timer_res = client.post(f"/api/attempts/{attempt_id}/start-timer", headers=alice_headers)
    assert timer_res.status_code == 200

    # Get attempt
    res = client.get(f"/api/attempts/{attempt_id}", headers=alice_headers)
    assert res.status_code == 200
    attempt_data = res.json()
    questions = attempt_data["questions"]
    assert len(questions) >= 1

    # Save answers (Q0 correct: option 1, Q1 correct: option 2)
    q0_id = questions[0]["id"]
    res = client.post(f"/api/attempts/{attempt_id}/answers", json={"question_id": q0_id, "option_index": 1}, headers=alice_headers)
    assert res.status_code == 200

    q1_id = questions[1]["id"]
    res = client.post(f"/api/attempts/{attempt_id}/answers", json={"question_id": q1_id, "option_index": 2}, headers=alice_headers)
    assert res.status_code == 200

    # Test AI Event Proctoring (Confidence >= 0.95 -> high_review / flag)
    res = client.post(f"/api/attempts/{attempt_id}/ai-event", json={"event_type": "PHONE_DETECTED", "confidence": 0.96}, headers=alice_headers)
    assert res.status_code == 200
    data = res.json()
    assert data["action"] == "high_review"
    assert data["violation_logged"] is True
    assert data["violation_count"] == 1
    assert data["auto_submitted"] is False

    # Second violation -> reaches max_violations (2) -> Auto submit
    res = client.post(f"/api/attempts/{attempt_id}/ai-event", json={"event_type": "MULTIPLE_FACES", "confidence": 0.98}, headers=alice_headers)
    assert res.status_code == 200
    data = res.json()
    assert data["violation_count"] == 2
    assert data["auto_submitted"] is True

    # Check attempt score was auto-calculated for saved answers (1 + 1 = 2)
    res = client.get(f"/api/attempts/{attempt_id}", headers=alice_headers)
    assert res.status_code == 200
    assert res.json()["status"] == "auto_submitted"
    assert res.json()["score"] == 2

    # Upload Rough Work
    file_content = b"fake pdf content"
    files = {"file": ("rough.pdf", io.BytesIO(file_content), "application/pdf")}
    res = client.post(f"/api/attempts/{attempt_id}/rough-work", files=files, headers=alice_headers)
    assert res.status_code == 200
    assert res.json()["uploaded"] is True


def test_admin_flow(client):
    # Login Admin
    res = client.post("/api/auth/login", json={"email": settings.admin_email, "password": settings.admin_password})
    admin_token = res.json()["access_token"]
    admin_headers = {"Authorization": f"Bearer {admin_token}"}

    # Admin create exam
    res = client.post("/api/admin/exams", json={"title": "Physics Exam", "duration_minutes": 45, "max_violations": 3}, headers=admin_headers)
    assert res.status_code == 200
    exam_id = res.json()["id"]

    # Admin create question
    res = client.post(f"/api/admin/exams/{exam_id}/questions", json={"text": "Speed of light in m/s?", "options": ["3e8", "3e6", "1e5", "300"], "correct_answer": 0, "marks": 2}, headers=admin_headers)
    assert res.status_code == 200

    # Admin list exams
    res = client.get("/api/admin/exams", headers=admin_headers)
    assert res.status_code == 200
    assert len(res.json()) >= 2

    # Admin list attempts
    res = client.get("/api/admin/attempts", headers=admin_headers)
    assert res.status_code == 200
    attempts = res.json()
    assert len(attempts) > 0
    sample = attempts[0]
    assert "student" in sample
    assert "exam" in sample
    assert "violations" in sample
    assert "rough_work" in sample

    # Admin download rough work if available
    for att in attempts:
        if att.get("rough_work") and not att["rough_work"].get("skipped"):
            rw_id = att["rough_work"]["id"]
            download_res = client.get(f"/api/admin/rough-work/{rw_id}/download", headers=admin_headers)
            assert download_res.status_code == 200
            assert download_res.content == b"fake pdf content"
            break

    # Admin grant re-attempt test
    target_attempt_id = attempts[0]["id"]
    grant_res = client.post(f"/api/admin/attempts/{target_attempt_id}/grant-reattempt", headers=admin_headers)
    assert grant_res.status_code == 200
    assert grant_res.json()["granted"] is True


def test_subject_management(client):
    admin_res = client.post("/api/auth/login", json={"email": settings.admin_email, "password": settings.admin_password})
    admin_headers = {"Authorization": f"Bearer {admin_res.json()['access_token']}"}

    subj_name = f"Subject_{uuid.uuid4().hex[:6]}"
    create_res = client.post("/api/admin/subjects", json={"name": subj_name, "description": "Test subject description"}, headers=admin_headers)
    assert create_res.status_code == 200
    subj_id = create_res.json()["id"]

    list_res = client.get("/api/admin/subjects", headers=admin_headers)
    assert list_res.status_code == 200
    found = any(s["id"] == subj_id for s in list_res.json())
    assert found is True

    delete_res = client.delete(f"/api/admin/subjects/{subj_id}", headers=admin_headers)
    assert delete_res.status_code == 200
    assert delete_res.json()["deleted"] is True


def test_ai_exam_creation_and_delete(client):
    admin_res = client.post("/api/auth/login", json={"email": settings.admin_email, "password": settings.admin_password})
    admin_headers = {"Authorization": f"Bearer {admin_res.json()['access_token']}"}

    payload = {
        "title": "AI Generated Test Exam",
        "duration_minutes": 25,
        "max_violations": 2,
        "require_camera": True,
        "require_microphone": True,
        "questions": [
            {
                "text": "What is Python?",
                "options": ["A snake", "A programming language", "A car", "A planet"],
                "correct_answer": 1,
                "marks": 2,
                "difficulty": "easy"
            }
        ]
    }
    create_res = client.post("/api/admin/ai/create-exam-from-questions", json=payload, headers=admin_headers)
    assert create_res.status_code == 200
    exam_id = create_res.json()["exam_id"]

    # Delete the created exam
    del_res = client.delete(f"/api/admin/exams/{exam_id}", headers=admin_headers)
    assert del_res.status_code == 200
    assert del_res.json()["deleted"] is True


def test_ai_generator_fallback():
    from app.ai_generator import generate_questions
    syllabus = "Quantum mechanics is a fundamental theory in physics that provides a description of the physical properties of nature at the scale of atoms and subatomic particles."
    questions = generate_questions(api_key="", syllabus_text=syllabus, num_questions=5, subject_hint="Physics")
    assert len(questions) == 5
    assert "options" in questions[0]
    assert len(questions[0]["options"]) == 4
    assert questions[0]["correct_answer"] in range(4)


def test_mern_auth_flows(client):
    import pymongo
    from app.config import settings

    test_email = f"mern_user_{uuid.uuid4().hex[:6]}@example.com"
    pwd = "SecurePassword123!"

    # 1. Register
    reg_res = client.post(
        "/api/auth/register",
        json={"name": "MERN Tester", "email": test_email, "password": pwd, "role": "student"},
    )
    assert reg_res.status_code == 200
    reg_data = reg_res.json()
    assert reg_data["success"] is True
    assert reg_data["user"]["email"] == test_email
    assert reg_data["user"]["isAccountVerified"] is False
    token = reg_data["token"]
    refresh_token = reg_data["refreshToken"]
    auth_headers = {"Authorization": f"Bearer {token}"}

    # 2. Check is-auth & user data
    auth_check = client.get("/api/auth/is-auth", headers=auth_headers)
    assert auth_check.status_code == 200
    assert auth_check.json()["authenticated"] is True

    user_data = client.get("/api/user/data", headers=auth_headers)
    assert user_data.status_code == 200
    assert user_data.json()["userData"]["isAccountVerified"] is False

    # 3. Retrieve generated OTP directly from database to test verify-account
    mongo_client = pymongo.MongoClient(settings.mongodb_url)
    db = mongo_client[settings.mongodb_db_name]
    user_in_db = db.users.find_one({"email": test_email})
    assert user_in_db is not None
    otp = user_in_db.get("verifyOtp")
    assert len(otp) == 6

    # Test invalid OTP
    bad_verify = client.post("/api/auth/verify-account", json={"otp": "000000"}, headers=auth_headers)
    assert bad_verify.json()["success"] is False

    # Test valid OTP
    good_verify = client.post("/api/auth/verify-account", json={"otp": otp}, headers=auth_headers)
    assert good_verify.json()["success"] is True

    # Check updated verification state
    user_data_after = client.get("/api/user/data", headers=auth_headers)
    assert user_data_after.json()["userData"]["isAccountVerified"] is True

    # 4. Refresh token rotation
    rf_res = client.post("/api/auth/refresh-token", json={"refreshToken": refresh_token})
    assert rf_res.status_code == 200
    assert rf_res.json()["success"] is True
    new_token = rf_res.json()["token"]
    assert new_token

    # 5. Forgot password flow
    send_reset = client.post("/api/auth/send-reset-otp", json={"email": test_email})
    assert send_reset.status_code == 200
    assert send_reset.json()["success"] is True

    # Get reset OTP from DB
    user_in_db = db.users.find_one({"email": test_email.lower().strip()})
    assert user_in_db is not None, f"User with email {test_email} was not found in MongoDB"
    reset_otp = user_in_db.get("resetOtp")
    assert reset_otp is not None and len(reset_otp) == 6

    new_pwd = "BrandNewPassword456!"
    reset_res = client.post(
        "/api/auth/reset-password",
        json={"email": test_email, "otp": reset_otp, "newPassword": new_pwd},
    )
    assert reset_res.status_code == 200
    assert reset_res.json()["success"] is True

    # 6. Login with new password
    login_new = client.post("/api/auth/login", json={"email": test_email, "password": new_pwd})
    assert login_new.status_code == 200
    assert login_new.json()["success"] is True
    assert login_new.json()["user"]["isAccountVerified"] is True

    # 7. Cleanup
    db.users.delete_one({"email": test_email.lower().strip()})


def test_coding_question_and_grading_flow(client):
    # 1. Login Admin
    admin_res = client.post("/api/auth/login", json={"email": settings.admin_email, "password": settings.admin_password})
    assert admin_res.status_code == 200
    admin_headers = {"Authorization": f"Bearer {admin_res.json()['access_token']}"}

    # 2. Create Coding Exam
    exam_res = client.post(
        "/api/admin/exams",
        json={"title": "Python Certification Exam", "duration_minutes": 60, "max_violations": 3},
        headers=admin_headers,
    )
    assert exam_res.status_code == 200
    exam_id = exam_res.json()["id"]

    # 3. Add MCQ Question
    q1_res = client.post(
        f"/api/admin/exams/{exam_id}/questions",
        json={
            "type": "mcq",
            "text": "What is the output of type(10)?",
            "options": ["<class 'int'>", "<class 'str'>", "<class 'float'>", "<class 'list'>"],
            "correct_answer": 0,
            "marks": 2,
        },
        headers=admin_headers,
    )
    assert q1_res.status_code == 200

    # 4. Add Coding Question
    q2_res = client.post(
        f"/api/admin/exams/{exam_id}/questions",
        json={
            "type": "code",
            "language": "python",
            "text": "Write a python programming language code to take two numbers from the user and find their sum using Typecasting.",
            "starter_code": "# Write Python code here\n",
            "sample_solution": "a = int(input())\nb = int(input())\nprint(a + b)",
            "marks": 8,
        },
        headers=admin_headers,
    )
    assert q2_res.status_code == 200

    # 5. Register & Start Exam as Student
    bob_email = f"bob_{uuid.uuid4().hex[:6]}@example.com"
    reg_res = client.post("/api/auth/register", json={"name": "Bob Programmer", "email": bob_email, "password": "Password123!"})
    bob_token = reg_res.json()["access_token"]
    bob_headers = {"Authorization": f"Bearer {bob_token}"}

    start_res = client.post(f"/api/exams/{exam_id}/start", headers=bob_headers)
    assert start_res.status_code == 200
    attempt_id = start_res.json()["attempt_id"]

    # Start timer
    client.post(f"/api/attempts/{attempt_id}/start-timer", headers=bob_headers)

    # 6. Fetch attempt and check questions
    att_res = client.get(f"/api/attempts/{attempt_id}", headers=bob_headers)
    assert att_res.status_code == 200
    att_data = att_res.json()
    qs = att_data["questions"]
    assert len(qs) == 2
    assert qs[1]["type"] == "code"
    assert qs[1]["language"] == "python"

    # 7. Submit MCQ Answer
    ans1_res = client.post(
        f"/api/attempts/{attempt_id}/answers",
        json={"question_id": qs[0]["id"], "option_index": 0},
        headers=bob_headers,
    )
    assert ans1_res.status_code == 200

    # 8. Submit Code Answer (text_answer)
    submitted_code = "n1 = int(input())\nn2 = int(input())\nprint(n1 + n2)"
    ans2_res = client.post(
        f"/api/attempts/{attempt_id}/answers",
        json={"question_id": qs[1]["id"], "text_answer": submitted_code},
        headers=bob_headers,
    )
    assert ans2_res.status_code == 200
    assert ans2_res.json()["answers"][str(qs[1]["id"])] == submitted_code

    # 9. Submit Exam
    sub_res = client.post(f"/api/attempts/{attempt_id}/submit", headers=bob_headers)
    assert sub_res.status_code == 200
    # MCQ gives 2 marks automatically
    assert sub_res.json()["score"] == 2

    # 10. Admin inspects attempts and grades the coding question
    admin_att_res = client.get("/api/admin/attempts", headers=admin_headers)
    assert admin_att_res.status_code == 200
    all_atts = admin_att_res.json()
    my_att = next(a for a in all_atts if a["id"] == attempt_id)
    assert my_att["answers"][str(qs[1]["id"])] == submitted_code

    # Admin grades question 2 with full 8 marks and feedback
    grade_res = client.post(
        f"/api/admin/attempts/{attempt_id}/grade",
        json={
            "grades": {str(qs[1]["id"]): 8},
            "feedback": "Excellent use of typecasting and standard input parsing.",
        },
        headers=admin_headers,
    )
    assert grade_res.status_code == 200
    assert grade_res.json()["score"] == 10  # 2 from MCQ + 8 from Code
    assert grade_res.json()["manual_grades"][str(qs[1]["id"])] == 8


def test_faculty_invite_and_join_flow(client):
    """Test the complete faculty invite and student join workflow."""
    # ── 1. Register Faculty A ──
    fac_a_email = f"faculty_a_{uuid.uuid4().hex[:6]}@example.com"
    res = client.post("/api/auth/register", json={
        "name": "Prof. Alpha",
        "email": fac_a_email,
        "password": "FacultyPass123!",
        "role": "faculty",
    })
    assert res.status_code == 200
    assert res.json()["success"] is True
    assert res.json()["user"]["role"] == "faculty"
    fac_a_token = res.json()["access_token"]
    fac_a_headers = {"Authorization": f"Bearer {fac_a_token}"}

    # ── 2. Faculty A gets invite token ──
    res = client.get("/api/faculty/invite", headers=fac_a_headers)
    assert res.status_code == 200
    invite_a = res.json()["invite_token"]
    assert len(invite_a) > 20  # secure token

    # ── 3. Regenerate invite token ──
    res = client.post("/api/faculty/invite/regenerate", headers=fac_a_headers)
    assert res.status_code == 200
    new_invite_a = res.json()["invite_token"]
    assert new_invite_a != invite_a  # Must be different
    invite_a = new_invite_a  # Use the new one going forward

    # ── 4. Register Faculty B ──
    fac_b_email = f"faculty_b_{uuid.uuid4().hex[:6]}@example.com"
    res = client.post("/api/auth/register", json={
        "name": "Prof. Beta",
        "email": fac_b_email,
        "password": "FacultyPass123!",
        "role": "faculty",
    })
    assert res.status_code == 200
    fac_b_token = res.json()["access_token"]
    fac_b_headers = {"Authorization": f"Bearer {fac_b_token}"}
    res = client.get("/api/faculty/invite", headers=fac_b_headers)
    invite_b = res.json()["invite_token"]

    # ── 5. Register Student ──
    student_email = f"stud_{uuid.uuid4().hex[:6]}@example.com"
    res = client.post("/api/auth/register", json={
        "name": "Alice Student",
        "email": student_email,
        "password": "StudentPass123!",
        "role": "student",
    })
    assert res.status_code == 200
    assert res.json()["user"]["role"] == "student"
    stud_token = res.json()["access_token"]
    stud_headers = {"Authorization": f"Bearer {stud_token}"}

    # ── 6. Student joins Faculty A ──
    res = client.post("/api/student/join-faculty", json={
        "invite_token": invite_a,
    }, headers=stud_headers)
    assert res.status_code == 200
    assert res.json()["success"] is True
    assert "Prof. Alpha" in res.json()["message"]

    # ── 7. Student joins Faculty B ──
    res = client.post("/api/student/join-faculty", json={
        "invite_token": invite_b,
    }, headers=stud_headers)
    assert res.status_code == 200
    assert res.json()["success"] is True

    # ── 8. Student is in BOTH faculties ──
    res = client.get("/api/student/faculties", headers=stud_headers)
    assert res.status_code == 200
    faculties = res.json()["faculties"]
    assert len(faculties) == 2
    faculty_names = {f["name"] for f in faculties}
    assert "Prof. Alpha" in faculty_names
    assert "Prof. Beta" in faculty_names

    # ── 9. Duplicate join prevention ──
    res = client.post("/api/student/join-faculty", json={
        "invite_token": invite_a,
    }, headers=stud_headers)
    assert res.status_code == 409  # Already joined

    # ── 10. Invalid token ──
    res = client.post("/api/student/join-faculty", json={
        "invite_token": "totally-invalid-token-xyz",
    }, headers=stud_headers)
    assert res.status_code == 404

    # ── 11. Faculty A sees only their students ──
    res = client.get("/api/faculty/students", headers=fac_a_headers)
    assert res.status_code == 200
    students_a = res.json()["students"]
    assert len(students_a) == 1
    assert students_a[0]["email"] == student_email

    # ── 12. Faculty B sees only their students ──
    res = client.get("/api/faculty/students", headers=fac_b_headers)
    assert res.status_code == 200
    students_b = res.json()["students"]
    assert len(students_b) == 1
    assert students_b[0]["email"] == student_email

    # ── 13. Faculty cannot join a faculty ──
    res = client.post("/api/student/join-faculty", json={
        "invite_token": invite_b,
    }, headers=fac_a_headers)
    assert res.status_code == 403

    # ── 14. Invite info endpoint ──
    res = client.get(f"/api/invite/{invite_a}/info", headers=stud_headers)
    assert res.status_code == 200
    assert res.json()["faculty_name"] == "Prof. Alpha"
    assert res.json()["already_joined"] is True
    assert res.json()["user_role"] == "student"

    # ── 15. Invalid invite info ──
    res = client.get("/api/invite/bogus-token-abc/info", headers=stud_headers)
    assert res.status_code == 404

    # ── 16. Student can paste full URL and it still works ──
    stud2_email = f"stud2_{uuid.uuid4().hex[:6]}@example.com"
    res = client.post("/api/auth/register", json={
        "name": "Bob Student",
        "email": stud2_email,
        "password": "StudentPass123!",
    })
    stud2_headers = {"Authorization": f"Bearer {res.json()['access_token']}"}
    res = client.post("/api/student/join-faculty", json={
        "invite_token": f"http://localhost:5173/#/join/{invite_a}",
    }, headers=stud2_headers)
    assert res.status_code == 200
    assert res.json()["success"] is True

    # Faculty A now has 2 students
    res = client.get("/api/faculty/students", headers=fac_a_headers)
    assert len(res.json()["students"]) == 2
