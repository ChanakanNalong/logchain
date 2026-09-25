# Encryption at rest — LUKS2 + TPM2 (PCI 3.1 · review B1 · next-steps 6.7)

ย้ายข้อมูลทั้งหมดของ LogChain ไปไว้ในไฟล์ LUKS2 ที่ mount ที่ `/srv/lcsecure` โดยไม่ต้องแบ่ง partition ใหม่

| อะไร | ที่เดิม (ไม่เข้ารหัส) | ที่ใหม่ |
|---|---|---|
| Docker data-root: volume ของ Postgres / standby / Vault / Kafka / Grafana / Prometheus + image | `/var/lib/docker` | `/srv/lcsecure/docker` |
| repo: `.env` · `infra/vault/.secrets/` (unseal key) · key ของ Kafka / TLS · `rclone.conf` · `backups/` | `~/Documents/logchain` | `/srv/lcsecure/home/logchain` (ที่เดิมเป็น symlink → path ไม่เปลี่ยน) |

- **ปลดล็อกตอน boot ด้วย TPM2 + PIN** — Secure Boot ของเครื่องนี้ปิดอยู่ ถ้าผูกกับ TPM อย่างเดียว (ไม่มี PIN) ใครเอา USB มา boot
  ระบบอื่นบนเครื่องนี้ก็ปลดได้ · PIN ผิดหลายครั้ง TPM ล็อกเอง (dictionary-attack lockout) · มี **recovery passphrase** สำรองเสมอ
- Docker ถูกตั้งให้ **รอ** `/srv/lcsecure` — ยังไม่ปลดล็อก = Docker ไม่ขึ้น (โปรเจกต์ Docker อื่นบนเครื่องย้ายไปด้วย)
- ตรวจผล: `./scripts/check-encryption-at-rest.sh` (อ่านอย่างเดียว · ใช้เป็นหลักฐาน audit)

> **สถานะ:** รันครบทุกขั้น (0–9) แล้ว 2026-09-25 — reboot ผ่าน · ลบ `docker.old` + ปิด swap แล้ว · `check-encryption-at-rest.sh` ✅ ครบ (worklog 2026-09-25)
> ⚠️ `/var/lib/docker.old` ถูกลบแล้ว — หัวข้อ **Rollback** ข้างล่างใช้ไม่ได้อีก

ใช้เวลา ~30–45 นาที (ส่วนใหญ่คือ rsync ~35 GB) · ระหว่างนั้น stack ทั้งหมด **ล่ม** · ทุกคำสั่งรันใน terminal ของเจ้าของเครื่อง

---

## 0. เตรียมก่อนเริ่ม

```bash
cd ~/Documents/logchain
# backup ล่าสุด + ส่งขึ้น Google Drive (สำรองไว้ถ้าย้ายพลาด)
docker exec logchain-postgres-backup sh /backup.sh once
docker exec logchain-backup-offsite sh /offsite.sh once
df -h /          # ต้องว่าง ≥ 200 GB (ไฟล์ 150 GB + สำเนาชั่วคราวระหว่าง rsync)
```

เตรียมใน password manager: **recovery passphrase** (ยาว ≥ 20 ตัว สุ่มจาก password manager) และ **PIN** ของ TPM (6–8 หลัก)
— recovery passphrase หาย + TPM เปลี่ยน (อัป BIOS / เปลี่ยนเมนบอร์ด / clear TPM) = **ข้อมูลในไฟล์หายถาวร**

## 1. หยุดทุกอย่าง

ปิด Claude Code / editor / terminal ที่เปิดค้างอยู่ใน `~/Documents/logchain` ก่อน — ขั้น 6 ย้ายโฟลเดอร์นี้ (โปรแกรมที่ยังเปิดอยู่
จะเขียนไฟล์ลงที่เดิมหรือพัง) · เปิดใหม่หลังขั้น 7 ได้ตามปกติ path เดิม

```bash
cd ~/Documents/logchain
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose stop      # stop ไม่ใช่ down -v — volume อยู่ครบ
sudo systemctl stop docker.socket docker.service
```

## 2. สร้างไฟล์ LUKS2

```bash
sudo fallocate -l 150G /var/lib/lcsecure.img
sudo chmod 600 /var/lib/lcsecure.img
sudo cryptsetup luksFormat --type luks2 /var/lib/lcsecure.img
#   พิมพ์ YES แล้วใส่ recovery passphrase จาก password manager (2 ครั้ง)
```

## 3. ผูก TPM2 + PIN

```bash
LOOP=$(sudo losetup -f --show /var/lib/lcsecure.img)
sudo systemd-cryptenroll --tpm2-device=auto --tpm2-pcrs=7 --tpm2-with-pin=yes "$LOOP"
#   ถาม recovery passphrase (ยืนยันว่าเป็นเจ้าของ) แล้วตั้ง PIN ใหม่
sudo systemd-cryptenroll "$LOOP"     # ต้องเห็น 2 slot: password + tpm2
sudo losetup -d "$LOOP"
```

## 4. ปลดล็อกอัตโนมัติตอน boot + mount

```bash
echo 'lcsecure /var/lib/lcsecure.img none luks,tpm2-device=auto,timeout=180' | sudo tee -a /etc/crypttab
#   timeout=180 = รอใส่ PIN ตอน boot 3 นาที (ตรงกับเครื่องจริง 2026-09-25 · ร่างแรกใช้ nofail) · พลาด → ดู "ใช้งานประจำวัน"
sudo systemctl daemon-reload
sudo systemctl start systemd-cryptsetup@lcsecure.service     # ถาม PIN
sudo mkfs.ext4 -L lcsecure /dev/mapper/lcsecure
sudo mkdir -p /srv/lcsecure
echo "UUID=$(sudo blkid -s UUID -o value /dev/mapper/lcsecure) /srv/lcsecure ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab
sudo systemctl daemon-reload
sudo mount /srv/lcsecure
findmnt /srv/lcsecure        # SOURCE ต้องเป็น /dev/mapper/lcsecure
```

## 5. ย้าย Docker data-root

```bash
sudo rsync -aHAX --numeric-ids --info=progress2 /var/lib/docker/ /srv/lcsecure/docker/
sudo mv /var/lib/docker /var/lib/docker.old        # เก็บไว้ rollback จนกว่าขั้น 8 จะผ่าน
echo '{ "data-root": "/srv/lcsecure/docker" }' | sudo tee /etc/docker/daemon.json
# Docker ต้องรอให้ไฟล์ถูกปลดล็อก + mount ก่อน — ไม่งั้นจะสร้าง data-root เปล่าบนดิสก์ธรรมดาแล้วขึ้นมาแบบไม่มีอะไรเลย
sudo mkdir -p /etc/systemd/system/docker.service.d
printf '[Unit]\nRequiresMountsFor=/srv/lcsecure\n' | sudo tee /etc/systemd/system/docker.service.d/10-lcsecure.conf
sudo systemctl daemon-reload
```

## 6. ย้าย repo (.env · secrets · backups)

```bash
sudo install -d -o "$USER" -g "$USER" -m 700 /srv/lcsecure/home
mv ~/Documents/logchain /srv/lcsecure/home/logchain
ln -s /srv/lcsecure/home/logchain ~/Documents/logchain
```

## 7. เปิดกลับ

```bash
sudo systemctl start docker
docker info --format '{{.DockerRootDir}}'          # ต้องเป็น /srv/lcsecure/docker
cd ~/Documents/logchain
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose up -d
./scripts/demo-preflight.sh
./scripts/check-encryption-at-rest.sh               # ต้องขึ้น "ผ่าน"
```

เปิด https://localhost:3453 ดูว่าข้อมูลเดิมอยู่ครบ (alert · batch · integrity 100%)

## 8. ทดสอบ reboot (สำคัญ — พิสูจน์ว่าปลดล็อกเองได้)

`sudo reboot` → ระหว่าง boot จะถาม PIN ของ `lcsecure` → login → `docker compose ps` ต้องขึ้นครบเอง ·
`./scripts/check-encryption-at-rest.sh` ผ่าน

ผ่านแล้วค่อยลบของเก่า + ให้ SSD ทิ้ง block ที่ว่าง (ลดโอกาสกู้ข้อมูล plaintext เดิม):

```bash
sudo rm -rf /var/lib/docker.old
sudo fstrim -v /
```

> ข้อมูลที่เคยอยู่บนดิสก์ธรรมดาก่อนหน้านี้ (secret ใน `.env` ฯลฯ) อาจยังกู้จาก SSD ได้แม้ลบแล้ว — rotate secret รอบถัดไป
> (ภายใน 2026-12-16 · `docs/Key-Rotation-Policy.md`) จะทำให้ค่าเก่าที่อาจหลงเหลือใช้ไม่ได้

## 9. (แนะนำ) swap

`/swapfile` ไม่เข้ารหัส — หน่วยความจำที่มี secret ถูกเขียนลงดิสก์ได้ · RAM เหลือพอ → ปิด swap:
`sudo swapoff /swapfile` แล้ว comment บรรทัด `/swapfile` ใน `/etc/fstab` (อยากเก็บ swap ไว้: ทำ swap เข้ารหัสด้วย key สุ่มทุก boot
ผ่าน `/etc/crypttab` — แต่ hibernate จะใช้ไม่ได้)

---

## ใช้งานประจำวัน

| สถานการณ์ | ทำอะไร |
|---|---|
| boot ปกติ | ใส่ PIN ตอนถูกถาม → Docker ขึ้นเอง |
| boot แล้วพลาดช่องใส่ PIN / Docker ไม่ขึ้น | `sudo systemctl start systemd-cryptsetup@lcsecure.service` (ถาม PIN) → `sudo mount /srv/lcsecure` → `sudo systemctl start docker` |
| TPM ไม่ยอม (อัป BIOS / เปลี่ยน Secure Boot / PIN ผิดจนล็อก) | ใส่ **recovery passphrase** แทน PIN · แล้วผูก TPM ใหม่: `sudo systemd-cryptenroll --wipe-slot=tpm2 --tpm2-device=auto --tpm2-pcrs=7 --tpm2-with-pin=yes /var/lib/lcsecure.img` (ต้องผ่าน loop แบบขั้น 3) |
| พื้นที่ใกล้เต็ม | ขยายไฟล์: หยุด Docker → `sudo umount /srv/lcsecure` → `sudo truncate -s +50G /var/lib/lcsecure.img` → เปิดใหม่ → `sudo cryptsetup resize lcsecure` → `sudo resize2fs /dev/mapper/lcsecure` |

## Rollback (ก่อนขั้น 8 ลบ `docker.old`)

```bash
cd ~ && HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose -f ~/Documents/logchain/docker-compose.yml stop
sudo systemctl stop docker.socket docker.service
rm ~/Documents/logchain && mv /srv/lcsecure/home/logchain ~/Documents/logchain
sudo rm /etc/docker/daemon.json /etc/systemd/system/docker.service.d/10-lcsecure.conf
sudo mv /var/lib/docker.old /var/lib/docker
sudo umount /srv/lcsecure && sudo systemctl stop systemd-cryptsetup@lcsecure.service
# ลบบรรทัด lcsecure ใน /etc/crypttab และ /etc/fstab
sudo systemctl daemon-reload && sudo systemctl start docker
```
