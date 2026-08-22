#!/usr/bin/env bash
# start backend + detection ในโหมด mTLS (ใช้ก่อน demo)
export KAFKA_SSL_ENABLED=true
export KAFKA_BROKERS=localhost:39092,localhost:39093,localhost:39094
export KAFKA_BROKER=$KAFKA_BROKERS

kill $(lsof -t -i:3000) 2>/dev/null; pkill -f "app.consumer" 2>/dev/null; sleep 2
( cd ~/Documents/logchain && npm run start:dev > /tmp/logchain-backend.log 2>&1 & )
( cd ~/Documents/logchain-detection && source venv/bin/activate && \
  python3 -m app.consumer > /tmp/logchain-detection.log 2>&1 & )

echo "รอ service ขึ้น..."; sleep 20
echo "── socket check ──"
ss -tnp 2>/dev/null | grep -E ":(29092|39092)" | grep -E "node|python" | awk '{print $5, $6}'
echo "(ต้องเห็นแค่ :39092 — ถ้าเห็น 29092 แปลว่ายังเป็น plaintext)"
echo "log: /tmp/logchain-backend.log , /tmp/logchain-detection.log"
