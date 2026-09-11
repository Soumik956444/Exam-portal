# Secure Exam Portal — Phase-by-Phase Build

This repository is a development MVP implementing the requested architecture in eight phases.

### 1. Authentication
Student registration/login, Argon2 hashing, JWT, role support and password re-authentication before an exam.

### 2. Exam Engine
Exams, questions, attempts, answer saving, server-side scoring and submission states.

### 3. Auto-submit / Violation System
Visibility/tab-switch events, full-screen exit events, violation logging and configurable automatic submission.

### 4. Camera Proctoring
Mandatory camera/microphone permission gate and live camera preview. The browser's media APIs are used rather than claiming impossible OS-level surveillance.

### 5. Rough Work
After submission, the student can upload PDF/JPG/JPEG/PNG rough work or skip it. The database records the outcome.

### 6. Admin Panel
Admin APIs and UI for exams and attempt monitoring. Question creation API is included.

### 7. AI Proctoring
An AI event adapter and policy layer are included. Connect a production computer-vision service to send events such as multiple faces, phone detection, face missing and camera blocked.

### 8. Security Hardening
Documentation/checklists cover HTTPS, MongoDB security/indexes, secret management, rate limiting, upload scanning, private storage, security headers, audit logs, backups, privacy and testing.

## Run locally

### Backend
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python seed.py
uvicorn app.main:app --reload --port 8001
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

Demo accounts:
- Student: `student@example.com` / `ChangeMe123!`
- Admin: `admin@example.com` / `ChangeMe123!`

Change demo passwords before deployment.

## Important security limitation
A normal browser cannot reliably detect every OS-level screenshot, a separate physical device, Google Lens on a phone, or every external application. This system therefore uses layered controls and an auditable violation/evidence model instead of promising 100% cheat prevention.

For a real deployment, add formal privacy/consent/retention controls and have the security architecture independently reviewed.
