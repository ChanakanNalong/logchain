"""
FastAPI service สำหรับ Deeplog anomaly detection
"""
from fastapi import FastAPI, HTTPException
from contextlib import asynccontextmanager
from prometheus_fastapi_instrumentator import Instrumentator

from app.model import get_detector, WINDOW_SIZE, NUM_CLASSES, TOP_K_G
from app.batch_model import get_batch_detector
from app.schemas import (
    DetectRequest,
    DetectResponse,
    HealthResponse,
    BatchDetectRequest,
    BatchDetectResponse,
)

@asynccontextmanager
async def lifespan(app: FastAPI):
    """ โหลด model ตอน service start (warm up) - request แรกจะไม่ช้า """
    print("Loading Deeplog model...")
    get_detector()
    bd = get_batch_detector()
    print(f"Isolation Forest: {'loaded' if bd.available else 'unavailable — ' + str(bd.unavailable_reason)}")
    print("Service ready.")
    yield
    print("Shutting down.")

app = FastAPI(
    title="Logchain Detection Service",
    description="Deeplog-based anomaly detection (F1=0.71 on HDFS)",
    version="1.0.0",
    lifespan=lifespan,
)

# ---- Prometheus metrics ----
# expose ที่ metrics - track request count/duration/size อัตโนมัติ
Instrumentator().instrument(app).expose(app, endpoint="/metrics")

@app.get("/health", response_model=HealthResponse, tags=["System"])
def health():
    """ Liveness check + service info """
    detector = get_detector()
    return HealthResponse(
        status="ok",
        model_loaded=True,
        device=str(detector.device),
        num_log_keys=NUM_CLASSES - 1,   # ลบ index 0 (padding)
        window_size=WINDOW_SIZE,
    )

@app.post("/api/v1/detect", response_model=DetectResponse, tags=["detection"])
def detect(req: DetectRequest):
    """
    ตรวจสอบ sequence ว่าเป็น anomaly ไหม

    กฎ:
    - sequence สั้นกว่า window+1 -> anomaly (ผิดปกติ lifecycle)
    - Deeplog ทำนาย next log key, ถ้าไม่อยู่ใน top-8 -> anomaly
    """
    try:
        # ตรวจว่า log key อยู่ในช่วงที่ model รู้จัก
        if any(k < 0 or k >= NUM_CLASSES for k in req.sequence):
            raise HTTPException(
                status_code=400,
                detail=f"log key ต้องอยู่ในช่วง 0-{NUM_CLASSES - 1}",
            )
        detector = get_detector()
        return DetectResponse(**detector.detect(req.sequence))
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v1/detect-batch", response_model=BatchDetectResponse, tags=["detection"])
def detect_batch(req: BatchDetectRequest):
    """
    จำแนก batch ว่าผิดปกติไหมด้วย Isolation Forest (ตรวจจับระดับที่ 3)

    backend เรียกตอนปิด batch · ถ้ายังไม่ได้ train โมเดล จะคืน model_available=False
    และ is_anomaly=False เพื่อให้ปิด batch ได้ตามปกติ (ระดับที่ 3 เป็นส่วนเสริม)
    """
    try:
        detector = get_batch_detector()
        logs = [log.model_dump() for log in req.logs]
        return BatchDetectResponse(**detector.score_batch(logs))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))