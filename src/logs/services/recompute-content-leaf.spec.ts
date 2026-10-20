import { createHash } from 'crypto';
import {
  computeRawHash,
  isRawHashIntact,
  recomputeContentLeaf,
  type RawHashInput,
} from './log-hash';

/**
 * recomputeContentLeaf — leaf ของ contentRoot/proof (คำนวณจากเนื้อหาปัจจุบัน, version-aware)
 *
 * 4 กรณีตามตาราง: ไม่แก้ · แก้ message · แก้ raw_hash · แก้ทั้งคู่ + log v1 (legacy)
 * intact → ต้องคืน raw_hash ที่เก็บไว้ (leaf เท่าเดิม → contentRoot เขียว)
 * เนื้อหาถูกแก้ → ต้องต่างจาก raw_hash เดิม (→ contentRoot แดง)
 */
const base: RawHashInput = {
  id: 'c01c7c4f-b826-42b0-b447-36713ee74061',
  source: 'vps-sshd',
  sourceIp: '10.10.31.19',
  eventType: 'SSH_AUTH',
  severity: 'INFO',
  message: 'Accepted publickey for root',
  classification: 'INTERNAL',
  cdeScope: false,
  createdAt: new Date('2026-10-19T16:26:08.248Z'),
};
const origHash = computeRawHash(base); // raw_hash v2 ที่เก็บตอน seal

describe('recomputeContentLeaf', () => {
  it('ไม่แก้อะไร → leaf = raw_hash ที่เก็บไว้ (intact)', () => {
    const log = { ...base, rawHash: origHash };
    expect(isRawHashIntact(log)).toBe(true);
    expect(recomputeContentLeaf(log)).toBe(origHash);
  });

  it('แก้ message (raw_hash เดิม) → leaf ต่างจาก raw_hash (contentRoot แดง)', () => {
    const log = { ...base, message: 'hacked', rawHash: origHash };
    expect(isRawHashIntact(log)).toBe(false);
    const leaf = recomputeContentLeaf(log);
    expect(leaf).not.toBe(origHash);
    expect(leaf).toBe(computeRawHash({ ...base, message: 'hacked' }));
  });

  it('แก้ raw_hash (เนื้อหาเดิม) → leaf = hash ของเนื้อหาเดิม = origHash (contentRoot เขียว · storedHashRoot แดง)', () => {
    const log = { ...base, rawHash: 'f'.repeat(64) };
    expect(isRawHashIntact(log)).toBe(false);
    // เนื้อหาไม่เปลี่ยน → recompute ได้ origHash (ต่างจาก raw_hash all-f ที่เก็บไว้)
    expect(recomputeContentLeaf(log)).toBe(origHash);
    expect(recomputeContentLeaf(log)).not.toBe(log.rawHash);
  });

  it('แก้ทั้ง message + raw_hash ให้ตรงเนื้อหาใหม่ → intact ชั่วคราว แต่ leaf ≠ origHash (contentRoot แดงเทียบ chain)', () => {
    const forged = computeRawHash({ ...base, message: 'hacked' });
    const log = { ...base, message: 'hacked', rawHash: forged };
    expect(isRawHashIntact(log)).toBe(true); // raw_hash ตรงกับเนื้อหาที่ปลอม
    const leaf = recomputeContentLeaf(log);
    expect(leaf).toBe(forged);
    expect(leaf).not.toBe(origHash); // ต่างจากตอน anchor → contentRoot/chain แดง
  });

  it('log v1 (legacy) ที่ไม่ถูกแก้ → leaf = raw_hash v1 ที่เก็บไว้ (ไม่ false-flag)', () => {
    // hash v1 = sha256(JSON.stringify({source,eventType,message})) — ดู computeLegacyRawHash
    const v1 = createHash('sha256')
      .update(
        JSON.stringify({
          source: base.source,
          eventType: base.eventType,
          message: base.message,
        }),
      )
      .digest('hex');
    const log = { ...base, rawHash: v1 };
    expect(isRawHashIntact(log)).toBe(true);
    expect(recomputeContentLeaf(log)).toBe(v1);
  });
});
