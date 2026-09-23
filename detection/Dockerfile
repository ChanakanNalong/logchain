# Detection service — image เดียวรันได้ 2 บทบาท
#   detection-api      : uvicorn app.main:app        (CMD default ข้างล่าง)
#   detection-consumer : python -m app.consumer      (override ด้วย `command:` ใน compose)
#
# venv ที่ใช้งานจริงเป็น python3.12 — ยึดตามนั้นเพื่อให้ pickle ของ torch โหลดได้เหมือนกัน
FROM python:3.12-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# pip / setuptools ที่มากับ base image มีช่องโหว่ (pip-audit 2026-09-24) — อัปก่อนลงอย่างอื่น
RUN pip install --no-cache-dir --upgrade pip setuptools

# torch CPU wheel ต้องลงก่อน requirements.txt — default จาก PyPI เป็น build ที่
# ลาก nvidia CUDA libs มาด้วย ~3 GB ซึ่ง inference ไม่ได้ใช้เลย
# ลงแล้วบรรทัด torch==2.13.0 ใน requirements.txt จะถือว่า satisfied (2.13.0+cpu)
# ⚠️ scanner จับคู่ `+cpu` ไม่ได้ — ช่องโหว่ของ torch ใน image หลุดการ scan · CI จึง audit requirements.txt แทน
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \
        torch==2.13.0

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# โค้ด + กติกา + โมเดลที่ train แล้ว
# data/ เอาเฉพาะ 2 ไฟล์ที่ runtime ต้องใช้ — dataset ก้อนใหญ่ไม่ต้องเข้า image
COPY app/   ./app/
COPY rules/ ./rules/
COPY data/deeplog_model.pt data/drain_state.json ./data/

# GeoLite2-City.mmdb ไม่ได้อยู่ใน image (license ของ MaxMind + 66 MB)
# app/enrichment.py เช็ค .exists() อยู่แล้ว ไม่เจอก็แค่ปิด geo enrichment
# อยากได้ geo: mount เข้ามาที่ /app/data/GeoLite2-City.mmdb

RUN useradd --create-home --uid 10001 detection && chown -R detection:detection /app
USER detection

# 8000 = FastAPI, 9101 = prometheus_client ของ consumer (ตาม prometheus.yml)
EXPOSE 8000 9101

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
