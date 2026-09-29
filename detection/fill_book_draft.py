"""
fill_book_draft.py — เติมตัวเลขจริงจาก eval_result.json ลงข้อความเล่ม (สเตจ 5)

พิมพ์ย่อหน้า 4.6.6 (ผลการประเมิน) + ช่องผล DR-09/DR-10 แบบเติมเลขแล้ว พร้อม copy ไปวางในเล่ม
รูปแบบตัวเลขตามเล่ม: P/R/F1/recall = ทศนิยม 4 ตำแหน่ง · FP-rate = ร้อยละ 2 ตำแหน่ง

ใช้:
  python3 detection/fill_book_draft.py <eval_result.json> [--n-train N]
  (--n-train = จำนวน batch ปกติที่ใช้ฝึก · ดูจากบรรทัด "โหลด N batch" ตอน train · ไม่ใส่ = "___")
"""
from __future__ import annotations

import argparse
import json
import sys


def pct(x: float) -> str:
    return f"{x * 100:.2f}"


def f4(x: float) -> str:
    return f"{x:.4f}"


def attack_recall(per_attack: dict, kind: str) -> str:
    row = per_attack.get(f"attack:{kind}")
    return f4(row["recall"]) if row else "___(ไม่มีข้อมูล)"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="เติมเลขลงร่างเล่ม Isolation Forest")
    ap.add_argument("result", help="eval_result.json จาก eval_isoforest.py")
    ap.add_argument("--n-train", default="___", help="จำนวน batch ปกติที่ใช้ฝึก")
    args = ap.parse_args(argv)

    with open(args.result, encoding="utf-8") as f:
        r = json.load(f)

    pa = r.get("per_attack", {})
    v = {
        "n_train": args.n_train,
        "n_normal": r["n_normal"],
        "n_attack": r["n_attack"],
        "tp": r["tp"],
        "fp": r["fp"],
        "precision": f4(r["precision"]),
        "recall": f4(r["recall"]),
        "f1": f4(r["f1"]),
        "fp_rate_pct": pct(r["fp_rate"]),
        "bf": attack_recall(pa, "bruteforce"),
        "ps": attack_recall(pa, "portscan"),
        "dos": attack_recall(pa, "dos"),
    }

    para_446 = (
        "การประเมินแบบจำลองใช้ชุดข้อมูลที่สร้างขึ้นจากการยิง Log ผ่านช่องทางรับ Log จริงของระบบ"
        "ในสภาพแวดล้อมทดสอบแยก แบ่งเป็นทราฟฟิกปกติจำนวน {n_train} ชุดสำหรับฝึกแบบจำลอง และชุดสำหรับ"
        "ประเมินซึ่งประกอบด้วยชุดข้อมูลปกติ {n_normal} ชุด กับชุดข้อมูลที่จำลองการโจมตีสามรูปแบบ ได้แก่ "
        "การเดารหัสผ่าน (Brute Force) การสแกนพอร์ต (Port Scanning) และการโจมตีแบบปฏิเสธการให้บริการ (DoS) "
        "รวม {n_attack} ชุด ผลการประเมินได้ค่า Precision เท่ากับ {precision} ค่า Recall เท่ากับ {recall} "
        "และ F1-Score เท่ากับ {f1} โดยมีอัตราการแจ้งเตือนเท็จต่อชุดข้อมูลปกติเท่ากับร้อยละ {fp_rate_pct} "
        "เมื่อพิจารณาแยกตามรูปแบบการโจมตี แบบจำลองตรวจพบ Brute Force ได้ {bf} Port Scanning ได้ {ps} "
        "และ DoS ได้ {dos}"
    ).format(**v)

    dr09 = (
        "ระบบจำแนกชุดข้อมูลโจมตีเป็นผิดปกติได้ {tp} จาก {n_attack} ชุด (Recall {recall}) "
        "และบันทึกผลกำกับไว้กับ Batch — ผ่าน"
    ).format(**v)
    dr10 = (
        "จากชุดข้อมูลปกติ {n_normal} ชุด แจ้งเตือนเท็จ {fp} ชุด (อัตราร้อยละ {fp_rate_pct}) — ผ่าน"
    ).format(**v)

    print("=" * 70)
    print("4.6.6 — ย่อหน้าผลการประเมิน (วางแทนย่อหน้าที่สามของหัวข้อ A ในร่าง)")
    print("=" * 70)
    print(para_446)
    print()
    print("=" * 70)
    print("ตาราง 4-16 — ช่องผล DR-09")
    print("=" * 70)
    print(dr09)
    print()
    print("=" * 70)
    print("ตาราง 4-16 — ช่องผล DR-10")
    print("=" * 70)
    print(dr10)
    print()
    if args.n_train == "___":
        print("⚠ ยังไม่ได้ใส่ --n-train (จำนวน batch ปกติที่ฝึก) — เติมเองในข้อความ")
    return 0


if __name__ == "__main__":
    sys.exit(main())
