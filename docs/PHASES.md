# Secure Exam Portal — Phase-by-Phase Build

## Phase 1 — Authentication
- Student registration/login
- Argon2 password hashing
- JWT sessions
- Re-authentication before an exam
- Role-aware admin authentication

## Phase 2 — Exam Engine
- Exams, questions and attempts
- Answer autosave
- Server-side scoring
- Attempt state management
- Server-controlled duration and submission

## Phase 3 — Auto-submit / Violation System
- Tab/visibility change events
- Full-screen exit events
- Violation counter
- Configurable violation limit per exam
- Automatic submission at the limit
- Auditable violation records

## Phase 4 — Camera Proctoring
- Mandatory camera permission gate
- Microphone permission gate
- Camera preview during the exam
- Camera health events ready for the violation pipeline

## Phase 5 — Rough Work
- Rough-work screen appears after submission
- PDF/JPG/JPEG/PNG upload
- Skip option
- Upload/skip status stored against the attempt

## Phase 6 — Admin Panel
- Exam list
- Attempt list
- Exam/question creation APIs
- Violation and rough-work status visible to administrators

## Phase 7 — AI Proctoring
- AI event endpoint
- Confidence score support
- Event metadata support
- Policy pipeline shared with browser violations
- Suggested events: FACE_MISSING, MULTIPLE_FACES, PHONE_DETECTED, PERSON_DETECTED, FACE_MISMATCH, LOOKING_AWAY, CAMERA_BLOCKED

## Phase 8 — Security Hardening
- HTTPS
- PostgreSQL in production
- Strong secrets
- Exact CORS origins
- Rate limiting
- Private object storage
- Malware scanning
- CSP/security headers
- Audit logging
- Backup/restore
- Monitoring
- Privacy/retention controls
- Penetration and load testing

## What cannot be guaranteed by a normal browser
A web page cannot reliably detect every OS-level screenshot, a separate phone, Google Lens on another device, or every external application. The product should use layered controls, evidence, and a review policy rather than claiming 100% cheating prevention.
