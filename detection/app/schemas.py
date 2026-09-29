"""
Pydantic schemas - โครงสร้าง request/response ของ API
FastAPI จะ validate อัตโนมัติและ generate Swagger
"""
from pydantic import BaseModel, Field
from typing import List, Optional, Union

class DetectRequest(BaseModel):
    """
    Request สำหรับโหลด demo - รับ sequence ของ log key ตรงๆ
    เหมาะกับการทดสอบ model ที่ train แล้ว
    """
    sequence: List[int] = Field(
        ...,
        min_length=1,
        description="ลำดับ log keys (เช่น [1, 2, 3, 4, 5, 32, 17, 17])",
        examples=[[1, 1, 2, 3, 4, 5, 5, 32, 32, 17, 17]],
    )

class DetectResponse(BaseModel):
    is_anomaly: bool = Field(description="True = ผิดปกติ, False = ปกติ")
    reason: str = Field(description="เหตุผลที่ตัดสิน")
    sequence_length: int
    windows_checked: int = Field(description="จำนวน window ที่ทดสอบ (0 ถ้า sequence สั้น)")
    confidence: float = Field(
        description="สัดส่วน window ที่ผ่าน (0-1), 0 = ผิดทุก window",
        ge=0.0, le=1.0,
    )

class HealthResponse(BaseModel):
    status: str
    model_loaded: bool
    device: str
    num_log_keys: int
    window_size: int


# ---- Isolation Forest: จำแนก batch (ตรวจจับระดับที่ 3) ----

class BatchLog(BaseModel):
    """log หนึ่งรายการในชุด — backend ส่งเฉพาะ field ที่ใช้ทำ feature (ไม่ต้องส่ง message/hash)"""
    eventType: str = Field("", description="ประเภทเหตุการณ์ เช่น AUTH_FAILURE")
    severity: str = Field("INFO")
    sourceIp: Optional[str] = Field(None, description="IP ต้นทาง (หลัง PII-mask)")
    source: Optional[str] = Field(None, description="ชื่อ host/แหล่งที่มา")
    cdeScope: bool = Field(False)
    createdAt: Optional[Union[str, float]] = Field(
        None, description="ISO-8601 หรือ epoch seconds"
    )


class BatchDetectRequest(BaseModel):
    batch_id: Optional[str] = Field(None, description="id ของ batch (ใส่ได้เพื่อ trace)")
    logs: List[BatchLog] = Field(
        ..., min_length=1, description="log ทั้งหมดในชุดที่เพิ่งปิด"
    )


class BatchDetectResponse(BaseModel):
    is_anomaly: bool = Field(description="True = batch ผิดปกติ")
    score: float = Field(description="decision_function ของ Isolation Forest (ยิ่งต่ำยิ่งผิดปกติ)")
    model_available: bool = Field(description="False = ยังไม่ได้ train โมเดล (batch ปิดได้ตามปกติ)")
    reason: str
    features: List[float] = Field(description="feature vector ที่คำนวณได้")
    feature_names: List[str]