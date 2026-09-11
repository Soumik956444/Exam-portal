# AI Proctoring Adapter

This directory is deliberately model-agnostic. A production deployment can connect a CV service here (MediaPipe/OpenCV/YOLO/custom model, etc.).

Recommended pipeline:

camera -> frame sampler -> detector -> temporal smoothing -> policy -> API event -> audit/review

Do not upload every camera frame to the FastAPI application. Use an appropriate streaming/inference architecture for scale and privacy.
