#!/usr/bin/env bash
# สร้าง detection/requirements.lock ใหม่ — รันหลังแก้ detection/requirements.txt
#
# ทำขั้นเดียวกับ detection/Dockerfile แต่ไม่มี lock (ให้ pip เลือกรุ่นล่าสุดที่เข้ากับ requirements.txt)
# แล้ว pip freeze ออกมาเป็น lock ใหม่ → ต่อด้วย pip-audit ทั้งชุด
# ต้องมีเน็ต (โหลด torch CPU wheel ~200 MB)
set -euo pipefail
cd "$(dirname "$0")/../detection"

TORCH=$(grep -E '^torch==' requirements.txt | cut -d= -f3)
PY=$(sed -nE 's/^FROM python:([0-9.]+)-slim.*/\1/p' Dockerfile)

HEADER=$(grep '^#' requirements.lock 2>/dev/null || true)
FROZEN=$(docker run --rm -v "$PWD/requirements.txt:/r/requirements.txt:ro" "python:${PY}-slim" sh -ec "
  export PIP_DISABLE_PIP_VERSION_CHECK=1
  pip install -q --no-cache-dir --upgrade pip setuptools
  pip install -q --no-cache-dir --no-deps --index-url https://download.pytorch.org/whl/cpu torch==${TORCH}
  pip install -q --no-cache-dir -r /r/requirements.txt
  pip check >&2
  pip freeze --all | sed 's/+cpu\$//'
")
printf '%s\n%s\n' "$HEADER" "$FROZEN" > requirements.lock
echo "✓ เขียน detection/requirements.lock ($(echo "$FROZEN" | wc -l) แพ็กเกจ)"

echo "▶ pip-audit"
docker run --rm -v "$PWD/requirements.lock:/r/requirements.lock:ro" "python:${PY}-slim" sh -ec "
  pip install -q pip-audit 2>/dev/null
  pip-audit -r /r/requirements.lock --no-deps --disable-pip --progress-spinner off
"
echo "ต่อไป: HOST_UID=\$(id -u) HOST_GID=\$(id -g) docker compose build detection-api"
