from dataclasses import dataclass

@dataclass
class ProctoringDecision:
    action: str
    reason: str

_HIGH_REVIEW_EVENTS = {"CAMERA_DISABLED", "TAB_SWITCH", "FULLSCREEN_EXIT", "DEVTOOLS_ATTEMPT", "PHONE_DETECTED", "MULTIPLE_FACES"}

def decide(event_type: str, confidence: float) -> ProctoringDecision:
    if confidence >= 0.95 and (event_type in _HIGH_REVIEW_EVENTS or event_type.startswith("AI_")):
        return ProctoringDecision("high_review", f"High-confidence violation: {event_type}")

    if confidence >= 0.80:
        return ProctoringDecision("flag", f"AI warning: {event_type}")

    return ProctoringDecision("observe", f"Low-confidence event: {event_type}")
