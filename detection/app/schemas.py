"""
Pydantic schemas - โครงสร้าง request/response ของ API
FastAPI จะ validate อัตโนมัติและ generate Swagger
"""
from pydantic import BaseModel, Field
from typing import List

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