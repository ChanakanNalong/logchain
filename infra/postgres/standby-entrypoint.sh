#!/bin/sh
# Bootstrap ของ postgres-standby
#
# ปล่อยให้ docker-entrypoint.sh ทำงานเองไม่ได้: PGDATA ว่าง = มัน initdb เป็น cluster
# ใหม่เอี่ยมที่ไม่เกี่ยวกับ primary เลย (ได้ DB เปล่า ไม่ใช่ replica)
# standby ต้อง clone ข้อมูลจาก primary ผ่าน pg_basebackup เท่านั้น
#
# ทำครั้งเดียวตอน PGDATA ว่าง — restart ครั้งต่อ ๆ ไปจะข้ามไป start postgres ตรง ๆ
# แล้ว walreceiver จะไล่ WAL ตาม primary ต่อเองจากจุดที่ค้างไว้
set -eu

PGDATA=${PGDATA:-/var/lib/postgresql/data}
PRIMARY_HOST=${PRIMARY_HOST:-postgres}

if [ ! -s "$PGDATA/PG_VERSION" ]; then
    echo "▶ PGDATA ว่าง — กำลัง base backup จาก ${PRIMARY_HOST}"

    until pg_isready -h "$PRIMARY_HOST" -p 5432 >/dev/null 2>&1; do
        echo "… รอ primary พร้อมรับ connection"
        sleep 2
    done

    mkdir -p "$PGDATA"
    chown postgres:postgres "$PGDATA"
    rm -rf "${PGDATA:?}"/* 2>/dev/null || true

    # -Xs = stream WAL ระหว่าง backup กัน WAL ถูก recycle ทิ้งก่อน standby ตามทัน
    # -c fast = ไม่ต้องรอ checkpoint ตามรอบปกติ
    su-exec postgres env PGPASSWORD="$REPLICATION_PASSWORD" pg_basebackup \
        -h "$PRIMARY_HOST" -p 5432 -U replicator \
        -D "$PGDATA" -Fp -Xs -c fast -P

    # standby.signal = บอก postgres ให้ตื่นมาเป็น standby (read-only + ไล่ WAL ตาม primary)
    su-exec postgres touch "$PGDATA/standby.signal"

    # เขียน password ลง primary_conninfo ตรง ๆ เพราะ pg_basebackup -R ไม่เขียน password ให้
    # (walreceiver ต้อง auth ใหม่ทุกครั้งที่ reconnect ไม่ใช่แค่ตอน backup)
    su-exec postgres sh -c "cat >> '$PGDATA/postgresql.auto.conf'" <<-EOF
	primary_conninfo = 'host=${PRIMARY_HOST} port=5432 user=replicator password=${REPLICATION_PASSWORD} application_name=logchain-standby'
	EOF

    chmod 0700 "$PGDATA"
    echo "✓ base backup เสร็จ — standby พร้อมไล่ WAL ตาม primary"
fi

# ส่งต่อให้ entrypoint ปกติของ image (มันจะเห็นว่า PGDATA มีของแล้ว เลยข้าม initdb
# และไม่ต้องใช้ POSTGRES_PASSWORD ด้วย) — "$@" คือ command จาก compose
exec docker-entrypoint.sh "$@"
