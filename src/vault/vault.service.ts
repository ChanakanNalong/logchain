import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import vault from 'node-vault';

export interface LogChainSecrets {
  database: {
    password: string;
    keycloakPassword: string;
  };
  keycloak: {
    clientSecret: string;
    ingestorSecret: string;
    /** service-account client (logchain-admin-svc) สำหรับ Keycloak Admin REST */
    adminClientSecret: string;
  };
  blockchain: {
    privateKey: string;
  };
  notification: {
    host: string;
    port: string;
    user: string;
    pass: string;
    to: string;
  };
}

@Injectable()
export class VaultService implements OnModuleInit {
  private readonly logger = new Logger(VaultService.name);
  private client: any;
  private secrets: LogChainSecrets | null = null;
  private initPromise: Promise<void> | null = null;

  async onModuleInit() {
    await this.init();
  }

  /**
   * โหลด secrets จาก Vault (memoized - เรียกซ้ำได้ ทำงานจริงครั้งเดียว)
   *
   * ต้อง await ตัวนี้จาก useFactory ที่ต้องใช้ secret ตอน instantiate
   * เพราะ Nest สร้าง provider ทั้งหมดให้เสร็จก่อน แล้วค่อยเรียก onModuleInit
   */
  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.loadSecrets();
    }
    return this.initPromise;
  }

  private async loadSecrets() {
    const addr = process.env.VAULT_ADDR;
    const roleId = process.env.VAULT_NESTJS_ROLE_ID;
    const secretId = process.env.VAULT_NESTJS_SECRET_ID;

    if (!addr || !roleId || !secretId) {
      throw new Error(
        'Vault config missing - required: VAULT_ADDR, VAULT_NESTJS_ROLE_ID, VAULT_NESTJS_SECRET_ID',
      );
    }

    this.client = vault({ endpoint: addr });

    await this.loginWithRetry(roleId, secretId, 5);
    await this.fetchAllSecrets();
  }

  private async loginWithRetry(roleId: string, secretId: string, maxAttempts: number) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this.client.approleLogin({
          role_id: roleId,
          secret_id: secretId,
        });
        this.client.token = result.auth.client_token;
        this.logger.log(`Vault login OK (attempt ${attempt}, ttl=${result.auth.lease_duration}s)`);
        return;
      } catch (err: any) {
        this.logger.warn(`Vault login failed (attempt ${attempt}/${maxAttempts}): ${err.message}`);
        if (attempt === maxAttempts) {
          throw new Error(`Vault login failed after ${maxAttempts} attempts - app cannot start`);
        }
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }

  private async fetchAllSecrets() {
    try {
      const [db, kc, bc, notif] = await Promise.all([
        this.client.read('secret/data/logchain/database'),
        this.client.read('secret/data/logchain/keycloak'),
        this.client.read('secret/data/logchain/blockchain'),
        this.client.read('secret/data/logchain/notification'),
      ]);

      this.secrets = {
        database: {
          password: db.data.data.password,
          keycloakPassword: db.data.data.keycloak_password,
        },
        keycloak: {
          clientSecret: kc.data.data.client_secret,
          ingestorSecret: kc.data.data.ingestor_secret,
          adminClientSecret: kc.data.data.admin_client_secret,
        },
        blockchain: {
          privateKey: bc.data.data.private_key,
        },
        notification: {
          host: notif.data.data.host,
          port: notif.data.data.port,
          user: notif.data.data.user,
          pass: notif.data.data.pass,
          to: notif.data.data.to,
        },
      };

      this.logger.log('Vault secrets loaded (database, keycloak, blockchain, notification)');
    } catch (err: any) {
      throw new Error(`Vault secret fetch failed - app cannot start: ${err.message}`);
    }
  }

  get(): LogChainSecrets {
    if (!this.secrets) {
      throw new Error('Vault secrets not loaded - VaultService.onModuleInit did not complete');
    }
    return this.secrets;
  }
}
