import {
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VaultService } from '../vault/vault.service';

/** user representation ที่ Keycloak Admin REST คืนมา (เอาเฉพาะ field ที่ใช้) */
export interface KeycloakUser {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled: boolean;
}

interface KeycloakRole {
  id: string;
  name: string;
}

/** หน้ากันชนหมดอายุ token — refresh ก่อน exp จริง 30 วิ กัน race กับ clock skew */
const TOKEN_SKEW_MS = 30_000;

/** Keycloak /users คืนสูงสุด 100 ต่อ page — วนจนหมดแต่ไม่เกิน cap นี้ (กัน loop ยาว) */
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

/**
 * KeycloakAdminService — proxy เดียวที่แอปคุยกับ Keycloak Admin REST API
 *
 * ทำไมต้องผ่าน backend: frontend คุย Keycloak admin ตรง ๆ = ต้องแจก admin
 * credential ให้ browser ซึ่งเท่ากับยกสิทธิ์จัดการ realm ให้ใครก็ได้ที่เปิด devtools
 *
 * auth: client_credentials grant ของ confidential client `logchain-admin-svc`
 * ที่ถือเฉพาะ realm-management role เท่าที่ใช้ (view-users, view-realm,
 * manage-users) — ไม่ใช่ realm-admin — secret มาจาก Vault ไม่ใช่ .env
 */
@Injectable()
export class KeycloakAdminService {
  private readonly logger = new Logger(KeycloakAdminService.name);

  private readonly baseUrl: string;
  private readonly realm: string;
  private readonly clientId: string;

  private token: string | null = null;
  private tokenExpiresAt = 0;
  /** dedupe: หลาย request ที่ชนตอน token หมดอายุพร้อมกันต้องขอ token ใบเดียว */
  private tokenRequest: Promise<string> | null = null;

  /** role representation ไม่เปลี่ยน — cache ไว้กันยิง /roles/:name ซ้ำทุกครั้งที่ assign */
  private readonly roleCache = new Map<string, KeycloakRole>();

  constructor(
    private readonly vault: VaultService,
    private readonly config: ConfigService,
  ) {
    this.baseUrl = this.config
      .get<string>('KEYCLOAK_URL', 'http://localhost:8080')
      .replace(/\/+$/, '');
    this.realm = this.config.get<string>('KEYCLOAK_REALM', 'logchain');
    this.clientId = this.config.get<string>(
      'KEYCLOAK_ADMIN_CLIENT_ID',
      'logchain-admin-svc',
    );
  }

  // ── token ──────────────────────────────────────────────────────────────

  /** ขอ admin token (cache จนใกล้ exp แล้วค่อย refresh) */
  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    if (this.tokenRequest) return this.tokenRequest;

    this.tokenRequest = this.requestToken().finally(() => {
      this.tokenRequest = null;
    });
    return this.tokenRequest;
  }

  private async requestToken(): Promise<string> {
    await this.vault.init();
    const secret = this.vault.get().keycloak.adminClientSecret;
    if (!secret) {
      throw new ServiceUnavailableException(
        'Keycloak admin client secret missing in Vault (secret/logchain/keycloak → admin_client_secret)',
      );
    }

    const url = `${this.baseUrl}/realms/${this.realm}/protocol/openid-connect/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: secret,
    });

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (err: any) {
      throw new ServiceUnavailableException(
        `Keycloak unreachable: ${err.message}`,
      );
    }

    if (!res.ok) {
      // ห้าม log body — มี client_secret / error ที่อาจพ่วง credential
      this.logger.error(
        `Keycloak admin token request failed (HTTP ${res.status})`,
      );
      throw new ServiceUnavailableException(
        'Keycloak admin authentication failed',
      );
    }

    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.token = data.access_token;
    this.tokenExpiresAt =
      Date.now() + Math.max(data.expires_in * 1000 - TOKEN_SKEW_MS, 0);
    this.logger.log(`Keycloak admin token acquired (ttl=${data.expires_in}s)`);
    return this.token;
  }

  // ── admin REST ─────────────────────────────────────────────────────────

  private async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T | null> {
    const token = await this.getToken();
    const url = `${this.baseUrl}/admin/realms/${this.realm}${path}`;

    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
      });
    } catch (err: any) {
      throw new ServiceUnavailableException(
        `Keycloak unreachable: ${err.message}`,
      );
    }

    if (res.status === 404)
      throw new NotFoundException('User or role not found in Keycloak');
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.error(
        `Keycloak admin ${init.method ?? 'GET'} ${path} → ${res.status} ${detail}`,
      );
      throw new HttpException('Keycloak admin request failed', 502);
    }

    if (res.status === 204) return null;
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : null;
  }

  /** วน page จนกว่าจะได้ไม่เต็ม page (Keycloak ไม่คืน total ใน endpoint พวกนี้) */
  private async paginate<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 0; page < MAX_PAGES; page++) {
      const chunk =
        (await this.request<T[]>(
          `${path}${sep}first=${page * PAGE_SIZE}&max=${PAGE_SIZE}`,
        )) ?? [];
      out.push(...chunk);
      if (chunk.length < PAGE_SIZE) break;
    }
    return out;
  }

  /** user ทั้ง realm (brief representation — ไม่มี role) */
  listUsers(): Promise<KeycloakUser[]> {
    return this.paginate<KeycloakUser>('/users');
  }

  /** realm role ของ user คนเดียว (ชื่อ role ล้วน ยังไม่ filter allowlist) */
  async getUserRoles(userId: string): Promise<string[]> {
    const roles =
      (await this.request<KeycloakRole[]>(
        `/users/${userId}/role-mappings/realm`,
      )) ?? [];
    return roles.map((r) => r.name);
  }

  /** user ทุกคนที่ถือ realm role นี้ — ใช้นับ admin สำหรับ last-admin guard */
  getRoleUsers(role: string): Promise<KeycloakUser[]> {
    return this.paginate<KeycloakUser>(
      `/roles/${encodeURIComponent(role)}/users`,
    );
  }

  async assignRealmRole(userId: string, role: string): Promise<void> {
    const representation = await this.getRoleRepresentation(role);
    await this.request(`/users/${userId}/role-mappings/realm`, {
      method: 'POST',
      body: JSON.stringify([representation]),
    });
  }

  async removeRealmRole(userId: string, role: string): Promise<void> {
    const representation = await this.getRoleRepresentation(role);
    await this.request(`/users/${userId}/role-mappings/realm`, {
      method: 'DELETE',
      body: JSON.stringify([representation]),
    });
  }

  async setUserEnabled(userId: string, enabled: boolean): Promise<void> {
    await this.request(`/users/${userId}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });
  }

  /** Keycloak ต้องการ {id,name} ของ role ตอน map ไม่ใช่แค่ชื่อ */
  private async getRoleRepresentation(role: string): Promise<KeycloakRole> {
    const cached = this.roleCache.get(role);
    if (cached) return cached;

    const found = await this.request<KeycloakRole>(
      `/roles/${encodeURIComponent(role)}`,
    );
    if (!found) throw new NotFoundException(`Realm role not found: ${role}`);

    const representation = { id: found.id, name: found.name };
    this.roleCache.set(role, representation);
    return representation;
  }
}
