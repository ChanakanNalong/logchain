"""
Vault service - fetch secrets ตอน consumer start
Pattern A: bootstrap fetch, ถ้า vault ไม่พร้อม refuse to start
"""
import os
import time
import logging
from typing import Optional
import hvac

log = logging.getLogger("vault")

class VaultService:
    """ Fetch secrets จาก Vault ผ่าน AppRole authentication """

    def __init__(self):
        self.addr = os.getenv("VAULT_ADDR")
        self.role_id = os.getenv("VAULT_DETECTION_ROLE_ID")
        self.secret_id = os.getenv("VAULT_DETECTION_SECRET_ID")

        if not all([self.addr, self.role_id, self.secret_id]):
            raise RuntimeError(
                "Vault config missing - required: VAULT_ADDR, "
                "VAULT_DETECTION_ROLE_ID, VAULT_DETECTION_SECRET_ID"
                )
        
        self.client: Optional[hvac.Client] = None
        self._secrets: Optional[dict] = None

    def bootstrap(self, max_attempts: int = 5):
        """ login + fetch secrets - เรียกครั้งเดียวตอน comsumer start """
        self._login_with_retry(max_attempts)
        self._fetch_secrets()

    def _login_with_retry(self, max_attempts: int):
        """ AppRole login พร้อม exponential backoff """
        for attempt in range(1, max_attempts + 1):
            try:
                self.client = hvac.Client(url=self.addr)
                result = self.client.auth.approle.login(
                    role_id=self.role_id,
                    secret_id=self.secret_id,
                )
                ttl = result["auth"]["lease_duration"]
                log.info(f"Vault login OK (attempt {attempt}, ttl={ttl}s)")
                return
            except Exception as e:
                log.warning(f"Vault login failed (attempt {attempt}/{max_attempts}): {e}")
                if attempt == max_attempts:
                    raise RuntimeError(
                        f"Vault login failed after {max_attempts} attempts - consumer cannot start"
                    )
                time.sleep(2 ** attempt)  # exponential backoff

    def _fetch_secrets(self):
        """โหลด detect secrets - path: secret/data/logchain/detect """
        try:
            result = self.client.secrets.kv.v2.read_secret_version(
                path="logchain/detection"
            )
            data = result["data"]["data"]
            self._secrets = {
                "abuseip_key": data.get("abuseipdb_key", ""),
            }
            log.info("Vault secrets loaded (detection)")
        except Exception as e:
            raise RuntimeError(f"Vault secrets fetch failed - consumer cannot start: {e}")

    @property
    def abuseipdb_key(self) -> str:
        if self._secrets is None:
            raise RuntimeError("Vault not bootstrapped - call bootstrap() first")
        return self._secrets["abuseip_key"]

# Singleton
_vault: Optional[VaultService] = None

def get_vault() -> VaultService:
    global _vault
    if _vault is None:
        _vault = VaultService()
        _vault.bootstrap()
    return _vault