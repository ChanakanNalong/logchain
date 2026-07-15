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
    };
    blockchain: {
        privateKey: string;
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
     * -> ลำดับ import module ไม่ช่วยให้ onModuleInit ของ Vault มาก่อน
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

        // login + fetch พร้อม retry (vault อาจยังไม่พร้อมตอน app start)
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
                this.logger.log('Vault login OK (attempt ${attempt}, ttl=${result.auth.lease_duration}s)');
                return;
            } catch (err) {
                this.logger.warn('Vault login failed (attempt ${attempt}/${maxAttempts}): ${err.message}');
                if (attempt === maxAttempts) {
                    throw new Error('Vault login failed after ${maxAttempts} attempts - app cannot start');
                }
                await new Promise((r) => setTimeout(r, 2000 * attempt)); // exponential backoff
            }
        }
     }

     private async fetchAllSecrets() {
        try {
            const [db, kc, bc] = await Promise.all([
                this.client.read('secret/data/logchain/database'),
                this.client.read('secret/data/logchain/keycloak'),
                this.client.read('secret/data/logchain/blockchain')
            ]);

            this.secrets = {
                database: {
                    password: db.data.data.password,
                    keycloakPassword: db.data.data.keycloak_password,
                },
                keycloak: {
                    clientSecret: kc.data.data.client_secret,
                    ingestorSecret: kc.data.data.ingestor_secret,
                },
                blockchain: {
                    privateKey: bc.data.data.private_key,
                },
            };

            this.logger.log('Vault secrets loaded (database, keycloak, blockchain)');
        } catch (err) {
            throw new Error('Vault secret fetch failed - app cannot start: ${err.message}');
        }
     }

     get(): LogChainSecrets {
        if (!this.secrets) {
            throw new Error('Vault secrets not loaded - VaultService.onModuleInit did not complete');
        }
        return this.secrets;
     }
}