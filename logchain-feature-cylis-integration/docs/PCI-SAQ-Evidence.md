# PCI DSS SAQ-A Evidence Package
## Logchain — Cyber Security Log Integrity System

**Version:** 1.0
**Date:** 2026-06-04
**Prepared by:** Logchain Team

---

## SAQ-A Checklist

| Req | Description | Status | Evidence |
|-----|-------------|--------|----------|
| 1.1 | Firewall configuration | PASS | Docker network isolation |
| 2.1 | No vendor-supplied defaults | PASS | Custom JWT secret, no default passwords |
| 3.1 | Protect stored data | PASS | PostgreSQL encryption at rest |
| 4.1 | Encrypt transmission | PASS | HTTPS enforced, TLS on Kafka |
| 5.1 | Anti-malware | PASS | Trivy scan in CI/CD |
| 6.1 | Secure development | PASS | GitHub Actions security workflow |
| 6.2 | Vulnerability scan | PASS | Trivy + npm audit + pip audit |
| 7.1 | Restrict access by need | PASS | JWT role-based access control |
| 8.1 | Identify and authenticate | PASS | JWT authentication on all endpoints |
| 9.1 | Restrict physical access | N/A | Cloud/local deployment |
| 10.1 | Track and monitor access | PASS | AuditAccess entity logs all requests |
| 10.2 | Audit log retention | PASS | 90-day retention policy enforced |
| 11.1 | Vulnerability testing | PASS | Trivy CI scan on every push |
| 12.1 | Security policy | PASS | ISO 27001 ISMS document |

---

## Evidence Items

### E01 — JWT Authentication
- File: src/auth/auth.module.ts
- All endpoints protected by JWT guard

### E02 — Audit Logging
- File: src/common/interceptors/audit.interceptor.ts
- All API requests logged to audit_access table

### E03 — Blockchain Integrity
- Smart contract stores SHA-256 hash per log batch
- Immutable record on Polygon PoS

### E04 — Vulnerability Scanning
- File: .github/workflows/security.yml
- Trivy + npm audit + pip audit runs on every push

### E05 — Data Retention
- File: src/retention/retention.service.ts
- Cron job deletes records older than 90 days

### E06 — PDPA Erasure
- File: src/erasure/erasure.service.ts
- DELETE /erasure/user/:userId removes all personal data

### E07 — Alert Monitoring
- File: src/alerts/alerts.service.ts
- HIGH/CRITICAL alerts trigger email notification

---

## Attestation

ข้าพเจ้าขอรับรองว่าระบบ Logchain ได้ดำเนินการตามมาตรการความปลอดภัยที่ระบุไว้ในเอกสารนี้

**Signed:** ______________________
**Date:** 2026-06-04
