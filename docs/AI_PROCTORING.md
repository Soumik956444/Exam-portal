# AI Proctoring Production Design

## Signals
- Face missing
- Multiple faces
- Phone/object detection
- Person detection
- Face mismatch (only with explicit enrollment/consent)
- Looking-away/gaze signal
- Camera blocked

## Decision model
Use temporal smoothing. For example, do not act on one frame. Require a signal to persist across a configurable time window, then create an event with confidence and evidence metadata.

## Evidence
Store only the minimum evidence required by the institution's policy. Keep evidence private, encrypted at rest, access-controlled and subject to a documented retention period.

## Browser limitations
A website cannot reliably detect every screenshot method, a second physical device, or Google Lens on a phone. Camera proctoring can provide additional evidence but cannot eliminate those limitations.
