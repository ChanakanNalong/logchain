"""
โหลด Deeplog model + ทำ inference
แยกออกจาก main.py เพื่อให้ test ง่ายและ reload ได้
"""
import torch
import torch.nn as nn
from pathlib import Path
from prometheus_client import Counter, Histogram

# ---- custom metrics ----
ANOMALY_COUNT = Counter(
    "deeplog_anomaly_total",
    "Total anomalies detected by Deeplog",
    ["reason_type"],    # label: short_seq / window_failure
)

DETECT_DURATION = Histogram(
    "deeplog_detect_seconds",
    "Time spent in Deeplog inference",
)

# ---- ค่าคงที่ - ต้องตรงกับ Deeplog.py ตอน train
NUM_CLASSES = 48
WINDOW_SIZE = 10
HIDDEN_SIZE = 64
NUM_LAYERS  = 2
TOP_K_G     = 8     # ค่าที่ได้ F1 ดีสุดจาก detect.py
MODEL_PATH  = Path(__file__).parent.parent / "data" / "deeplog_model.pt"

class Deeplog(nn.Module):
    """ Deeplog LSTM - ต้องเหมือนกับใน deeplog_model.py """
    def __init__(self):
        super().__init__()
        self.lstm = nn.LSTM(1, HIDDEN_SIZE, NUM_LAYERS, batch_first=True)
        self.fc = nn.Linear(HIDDEN_SIZE, NUM_CLASSES)

    def forward(self, x):
        out, _ = self.lstm(x)
        return self.fc(out[:, -1, :])
    
class DeeplogDetector:
    """
    Wrapper สำหรับ inference ที่ใช้ใน API
    โหลด model ครั้งเดียวตอน service start แล้วเก็บใน memory
    """
    def __init__(self):
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.model = Deeplog().to(self.device)
        self.model.load_state_dict(torch.load(MODEL_PATH,map_location=self.device))
        self.model.eval()

    def detect(self, sequence: list[int]) -> dict:
        """
        ตรวจสอบ sequence ว่าเป็น anomaly ไหม
        return dict ที่ตรงกับ DetectResponse schema
        """
        with DETECT_DURATION.time():
            n = len(sequence)

            # rule 1: sequence สั้นกว่า window - ผิดปกติแน่ (จากผลทดสอบ HDFS)
            # 36.8% ของ HDFS anomaly สั้นกว่า window แต่ normal ไม่มีตัวสั้นเลย
            if n < WINDOW_SIZE + 1:
                ANOMALY_COUNT.labels(reason_type="short_seq").inc()
                return {
                    "is_anomaly": True,
                    "reason": f"sequence สั้นกว่า window ({n} < {WINDOW_SIZE + 1}) - ผิดปกติ",
                    "sequence_length": n,
                    "windows_checked": 0,
                    "confidence": 0.0,
                }
            
            # rule 2: ตรวจด้วย Deeplog - ดูว่าทุก window มี target ใน top-k ไหม
            windows, targets = [], []
            for i in range(n - WINDOW_SIZE):
                windows.append(sequence[i:i + WINDOW_SIZE])
                targets.append(sequence[i + WINDOW_SIZE])

            X = torch.tensor(windows, dtype=torch.float).unsqueeze(-1).to(self.device)
            y = torch.tensor(targets, dtype=torch.long).to(self.device)

            with torch.no_grad():
                output = self.model(X)
                _, topk =output.topk(TOP_K_G, dim=1)
                hit = (topk == y.unsqueeze(1)).any(dim=1)

            windows_checked = len(windows)
            windows_passed = int(hit.sum().item())
            confidence = windows_passed / windows_checked

            is_anomaly = not bool(hit.all())
            if is_anomaly:
                ANOMALY_COUNT.labels(reason_type="window_failure").inc()
                reason = (
                    f"{windows_checked - windows_passed}/{windows_checked} "
                    f"window มี target ที่ไม่อยู่ใน top-{TOP_K_G}"
                )
            else:
                reason = f"ทุก window ผ่าน (top-{TOP_K_G})"

            return {
                "is_anomaly": is_anomaly,
                "reason": reason,
                "sequence_length": n,
                "windows_checked": windows_checked,
                "confidence": confidence,
            }
    
# singleton - โหลด model ครั้งเดียว
_detector: DeeplogDetector | None = None


def get_detector() -> DeeplogDetector:
    global _detector
    if _detector is None:
        _detector = DeeplogDetector()
    return _detector