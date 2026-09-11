"""
ai_generator.py
---------------
PDF text extraction and Gemini-powered MCQ generation.
"""
from __future__ import annotations

import io
import json
import re
import logging
from typing import Any

logger = logging.getLogger(__name__)

# Maximum characters sent to Gemini (avoid huge token bills)
MAX_TEXT_CHARS = 40_000


def extract_pdf_text(file_bytes: bytes) -> str:
    """Extract plain text from a PDF byte string using pdfplumber."""
    try:
        import pdfplumber
    except ImportError:
        raise RuntimeError("pdfplumber is not installed. Please run `pip install pdfplumber` or activate the virtualenv.")

    text_parts: list[str] = []
    with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
        for page in pdf.pages:
            page_text = page.extract_text()
            if page_text:
                text_parts.append(page_text.strip())
    raw = "\n\n".join(text_parts)
    if len(raw) > MAX_TEXT_CHARS:
        raw = raw[:MAX_TEXT_CHARS] + "\n\n[... content truncated for analysis ...]"
    return raw.strip()


def _build_prompt(syllabus_text: str, num_questions: int, subject_hint: str) -> str:
    subject_line = f"Subject area: {subject_hint}\n" if subject_hint.strip() else ""
    return f"""You are an expert academic question-setter. Your task is to generate high-quality multiple-choice questions (MCQs) from the provided syllabus/study material.

{subject_line}Number of questions to generate: {num_questions}

Rules:
- Each question must have exactly 4 answer options (A, B, C, D).
- Exactly one option must be correct.
- Questions should span different difficulty levels (easy, medium, hard).
- Questions must be directly derived from the provided content.
- Do NOT repeat the same concept twice.
- correct_answer is the 0-based index of the correct option (0=A, 1=B, 2=C, 3=D).
- marks should be 1 for easy, 2 for medium, 3 for hard questions.

Return ONLY a valid JSON array with no markdown fences or extra text. Each element must follow this exact schema:
{{
  "text": "The question text here?",
  "options": ["Option A text", "Option B text", "Option C text", "Option D text"],
  "correct_answer": 0,
  "marks": 1,
  "difficulty": "easy"
}}

Syllabus / Study Material:
---
{syllabus_text}
---

Generate the JSON array now:"""


def _parse_gemini_response(raw: str) -> list[dict[str, Any]]:
    """Robustly parse JSON from Gemini output, stripping markdown fences if present."""
    cleaned = re.sub(r"```(?:json)?", "", raw).strip()
    start = cleaned.find("[")
    end = cleaned.rfind("]")
    if start == -1 or end == -1:
        raise ValueError("No JSON array found in AI response")
    json_str = cleaned[start : end + 1]
    data = json.loads(json_str)
    if not isinstance(data, list):
        raise ValueError("Expected a JSON array")

    validated: list[dict[str, Any]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text", "")).strip()
        options = item.get("options", [])
        correct = item.get("correct_answer", 0)
        marks = item.get("marks", 1)
        difficulty = item.get("difficulty", "medium")

        if not text:
            continue
        if not isinstance(options, list) or len(options) < 2:
            continue
        options = [str(o).strip() for o in options[:4]]
        while len(options) < 4:
            options.append(f"Option {len(options) + 1}")

        try:
            correct = int(correct)
            correct = max(0, min(correct, len(options) - 1))
        except (TypeError, ValueError):
            correct = 0

        try:
            marks = int(marks)
            marks = max(1, min(marks, 5))
        except (TypeError, ValueError):
            marks = 1

        validated.append(
            {
                "text": text,
                "options": options,
                "correct_answer": correct,
                "marks": marks,
                "difficulty": difficulty,
            }
        )

    return validated


def _generate_fallback_questions(
    syllabus_text: str,
    num_questions: int = 10,
    subject_hint: str = "",
) -> list[dict[str, Any]]:
    """
    Offline/Demo fallback generator when GEMINI_API_KEY is not set or API is unreachable.
    Extracts key sentences and concepts from the PDF text to create structured MCQs.
    """
    sentences = [s.strip() for s in re.split(r"[.\n]+", syllabus_text) if len(s.strip()) > 25]
    subject = subject_hint.strip() or "Syllabus Material"
    difficulties = ["easy", "medium", "hard"]
    questions: list[dict[str, Any]] = []

    for i in range(num_questions):
        sample = sentences[i % len(sentences)] if sentences else f"Section {i + 1} of syllabus"
        if len(sample) > 110:
            sample = sample[:107] + "..."

        diff = difficulties[i % 3]
        marks = 1 if diff == "easy" else (2 if diff == "medium" else 3)

        q_text = f"Which concept is highlighted in the {subject} excerpt: '{sample}'?"
        opt0 = f"It states a core principle regarding {subject}."
        opt1 = f"It represents a common misconception in {subject}."
        opt2 = f"It applies only under specialized experimental conditions."
        opt3 = f"It is an obsolete formulation replaced in recent literature."

        questions.append({
            "text": q_text,
            "options": [opt0, opt1, opt2, opt3],
            "correct_answer": 0,
            "marks": marks,
            "difficulty": diff,
        })

    return questions


def generate_questions(
    api_key: str,
    syllabus_text: str,
    num_questions: int = 10,
    subject_hint: str = "",
) -> list[dict[str, Any]]:
    """
    Generate MCQs from syllabus text using Gemini 2.0 Flash (if API key is present)
    or offline content-based fallback (if API key is empty/not configured).
    """
    if not api_key:
        logger.info("GEMINI_API_KEY is empty. Using offline fallback question generator.")
        return _generate_fallback_questions(syllabus_text, num_questions, subject_hint)

    try:
        from google import genai  # lazy import

        client = genai.Client(api_key=api_key)
        prompt = _build_prompt(syllabus_text, num_questions, subject_hint)

        response = client.models.generate_content(
            model="gemini-2.0-flash",
            contents=prompt,
        )
        raw_text = response.text or ""
        logger.info("Gemini raw response length: %d chars", len(raw_text))

        questions = _parse_gemini_response(raw_text)
        if not questions:
            return _generate_fallback_questions(syllabus_text, num_questions, subject_hint)
        return questions
    except Exception as err:
        logger.warning("Gemini API call failed (%s). Falling back to offline question generator.", err)
        return _generate_fallback_questions(syllabus_text, num_questions, subject_hint)
