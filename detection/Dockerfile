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

# ทุกอย่างลงด้วย -c requirements.lock (สร้างจาก ./scripts/detection-lock.sh) → รุ่นของ dependency ทางอ้อม
# ตรงกับที่ CI pip-audit เสมอ ไม่ใช่ "ล่าสุด ณ วันที่ build" (review B7 — เดิม audit แค่ตัวที่ pin ใน requirements.txt)
COPY requirements.txt requirements.lock ./

# pip / setuptools ที่มากับ base image มีช่องโหว่ (pip-audit 2026-09-24) — อัปก่อนลงอย่างอื่น
RUN pip install --no-cache-dir -c requirements.lock pip setuptools

# torch CPU wheel ต้องลงก่อน requirements.txt — default จาก PyPI เป็น build ที่
# ลาก nvidia CUDA libs มาด้วย ~3 GB ซึ่ง inference ไม่ได้ใช้เลย
# --no-deps: dependency ของ torch (sympy, jinja2, …) ไปลงจาก PyPI ตาม lock ในขั้นถัดไป ไม่ใช่รุ่นใดก็ได้จาก index ของ pytorch
# ลงแล้วบรรทัด torch==2.13.0 ใน requirements.txt จะถือว่า satisfied (2.13.0+cpu)
# ⚠️ scanner จับคู่ `+cpu` ไม่ได้ — ช่องโหว่ของ torch ใน image หลุดการ scan · CI จึง audit requirements.lock แทน
RUN pip install --no-cache-dir --no-deps --index-url https://download.pytorch.org/whl/cpu \
        torch==2.13.0

# -c บังคับได้แค่แพ็กเกจที่อยู่ใน lock — เพิ่มแพ็กเกจใหม่ใน requirements.txt แล้วลืมสร้าง lock ใหม่ dependency ของมัน
# จะลงรุ่นอะไรก็ได้โดยไม่ถูก audit → เทียบของที่ลงจริงกับ lock ให้ build พังแทน
RUN pip install --no-cache-dir -r requirements.txt -c requirements.lock && pip check \
    && pip freeze --all | sed 's/+cpu$//' > /tmp/installed.txt \
    && grep -v '^#' requirements.lock | diff -u - /tmp/installed.txt \
    || { echo "requirements.lock ไม่ตรงกับที่ลงจริง — รัน ./scripts/detection-lock.sh" >&2; exit 1; }

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
