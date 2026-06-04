# ISO 27001 ISMS Document
## Logchain — Cyber Security Log Integrity System on Blockchain

**Version:** 1.0
**Date:** 2026-06-04
**Prepared by:** Logchain Team

---

## 1. Scope

ระบบนี้ครอบคลุมการจัดเก็บ ตรวจสอบ และรับรองความสมบูรณ์ของ security log โดยใช้ blockchain technology ประกอบด้วย NestJS Backend, PostgreSQL, Elasticsearch, Kafka, Python FastAPI ML Detection, Polygon PoS Blockchain, Next.js Dashboard, Suricata และ Wazuh SIEM

---

## 2. Information Security Policy

องค์กรมุ่งมั่นในการรักษาความลับ (Confidentiality) ความสมบูรณ์ (Integrity) ด้วย blockchain hash และความพร้อมใช้งาน (Availability) ของระบบ

---

## 3. Risk Register

| ID | Asset | Threat | Likelihood | Impact | Risk Level | Control |
|----|-------|--------|------------|--------|------------|---------|
| R01 | Log data | Unauthorized modification | Medium | High | HIGH | Blockchain hash verification |
| R02 | API endpoints | Unauthorized access | Medium | High | HIGH | JWT authentication |
| R03 | Database | Data breach | Low | Critical | HIGH | Encryption at rest, access control |
| R04 | Private keys | Key theft | Low | Critical | HIGH | Vault service, key rotation |
| R05 | Personal data | PDPA violation | Low | High | MEDIUM | Right-to-erasure endpoint |
| R06 | Log retention | Data over-retention | Low | Medium | LOW | RetentionService cron 90 days |
| R07 | Container | Privilege escalation | Low | High | MEDIUM | Non-root container enforcement |
| R08 | Dependencies | Supply chain attack | Medium | High | HIGH | Trivy + npm/pip audit CI |

---

## 4. Annex A Control Mapping

| Control | Description | Implementation |
|---------|-------------|----------------|
| A.8.1 | Asset Management | Log entries tracked with UUID, timestamp, source |
| A.9.1 | Access Control Policy | JWT-based authentication on all API endpoints |
| A.9.4 | System Access Control | Role-based access, audit interceptor logs all access |
| A.10.1 | Cryptographic Controls | SHA-256 hash stored on blockchain per log batch |
| A.12.4 | Logging and Monitoring | Elasticsearch + Wazuh + ML anomaly detection |
| A.12.6 | Vulnerability Management | Trivy scan + npm audit + pip audit in CI/CD |
| A.16.1 | Incident Management | Alert system with severity routing + email notify |
| A.17.1 | Business Continuity | RTO/RPO defined in continuity plan |
| A.18.1 | Legal Compliance | PDPA right-to-erasure, 90-day retention policy |

---

## 5. Internal Audit Plan

| Audit Item | Frequency | Responsible |
|------------|-----------|-------------|
| Access log review | Monthly | Person 2 |
| Blockchain hash verification | Weekly | Person 1 |
| Vulnerability scan (Trivy) | Every push | GitHub Actions |
| Retention policy enforcement | Daily cron | Person 2 |
| Alert review | Daily | Person 2 |
