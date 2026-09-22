"""
IP enrichment - เพิ่ม context ของ IP ลงใน alert
- abuseIPUB: reputation, abuse confidence (online API)
- MaxMind GeoLite2: country, ASN (offline database)

ทั้งคู่ graceful fallback - ถ้าไม่มี key/file ก็คืน partial data
"""
import os
import logging
import requests
from pathlib import Path
from typing import Optional
log = logging.getLogger('enrichment')
from app.vault import get_vault

# ---- config -----
ABUSEIPDB_URL       = "https://api.abuseipdb.com/api/v2/check"
ABUSEIPDB_TIMEOUT   = 3 # วินาที - short timeout, alert ห้ามค้าง
GEOLITE_PATH        = Path(__file__).parent.parent / "data" / "GeoLite2-City.mmdb"

# ---- MaxMind GeoLite2 (offline) ----
_geoip_reader = None
try:
    import geoip2.database
    if GEOLITE_PATH.exists():
        _geoip_reader = geoip2.database.Reader(str(GEOLITE_PATH))
        log.info(f"GeoLite2 loaded from {GEOLITE_PATH}")
    else:
        log.warning(f"GeoLite2 not found at {GEOLITE_PATH} - geo enrichment disabled")
except ImportError:
    log.warning("geoip2 not installed - geo enrichment disabled")

def _lookup_geo(ip: str) -> dict:
    """ offline lookup ผ่าน Maxmind GeoLite2 not loaded """
    if not _geoip_reader:
        return {"available": False, "reason": "Geoline2 not loaded"}
    
    try:
        res = _geoip_reader.city(ip)
        return {
            "available": True,
            "country": res.country.name,
            "country_name": res.country.name,
            "city": res.city.name,
            "latitude": float(res.location.latitude) if res.location.latitude else None,
            "longitude": float(res.location.longitude) if res.location.longitude else None,
        }
    except Exception as e:
        # ส่วนใหญ่เจอตอน IP ไม่อยู่ใน DB (private TP, TP ใหม่)
        return {"available": False, "reason": str(e)}
    
# ---- AbuseIPDB (online API) ----
def _lookup_abuse(ip: str) -> dict:
    """ online lookup ผ่าน abuseIPDB """
    api_key = get_vault().abuseipdb_key
    if not api_key:
        return {"available": False, "reason": "no API key configured (mock mode)"}

    try:
        response = requests.get(
            ABUSEIPDB_URL,
            params={"ipAddress": ip, "maxAgeInDays": 90, "verbose": ""},
            headers={"Key": api_key, "Accept": "application/json"},
            timeout=ABUSEIPDB_TIMEOUT,
        )
        response.raise_for_status()
        data = response.json().get("data", {})
        return {
            "available":        True,
            "abuse_confidence": data.get("abuseConfidenceScore", 0),
            "total_reports":    data.get("totalReports", 0),
            "is_tor":           data.get("isTor", False),
            "usage_type":      data.get("usageType"),
            "isp":              data.get("isp"),
            "last_reported_at": data.get("lastReportedAt"),
        }
    except requests.RequestException as e:
        return {"available": False, "reason": f"API error: {e}"}
    
# ---- public function ----
def enrich_ip(ip: Optional[str]) -> dict:
    """
    รวม geo + reputation ใน dict เดียว
    return {} ถ้า ip เป็น None หรือ private/invalid
    """
    if not ip or _is_private_ip(ip):
        return {}
    
    return {
        "ip":   ip,
        "geo":  _lookup_geo(ip),
        "reputation": _lookup_abuse(ip),
    }

def _is_private_ip(ip: str) -> bool:
    """ กรอง private IP ไม่ต้อง enrich (RFC 1918 + loopback + link-local) """
    import ipaddress
    try:
        addr = ipaddress.ip_address(ip)
        return addr.is_private or addr.is_loopback or addr.is_link_local
    except ValueError:
        return True # ถ้า parse ไม่ได้ - ข้ามไป