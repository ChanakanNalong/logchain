#!/usr/bin/env bash
# ล้มงานถ้ามีไฟล์ประเภท "ความลับ" ถูก track ใน git
# เขียนขึ้นเพราะ Trivy secret scanner ไม่จับ .env ที่เป็น key=value ธรรมดา
# (พิสูจน์แล้วกับไฟล์ .env.bak ที่หลุดขึ้น public repo จริง — Trivy เงียบสนิท)
set -uo pipefail

bad=$(git ls-files | grep -E '(^|/)\.env($|\.)|\.(pem|key|p12|jks|keystore)$' \
      | grep -vE '\.(example|template|sample)$|\.env\.example$' || true)

if [ -n "$bad" ]; then
  echo "::error::พบไฟล์ความลับถูก track ใน git:"
  echo "$bad" | sed 's/^/  - /'
  echo ""
  echo "เอาออกด้วย: git rm --cached <file> แล้วเพิ่ม pattern ใน .gitignore"
  exit 1
fi
echo "✓ ไม่มีไฟล์ .env / key / cert ถูก track"
