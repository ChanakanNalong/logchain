import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';

// Keycloak realm roles ถูก map เป็น top-level claim `roles` (ดู realm-logchain.json)
interface KeycloakJwtPayload {
  sub: string;
  preferred_username?: string;
  email?: string;
  roles?: string[];
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService) {
    const keycloakUrl = config.get<string>(
      'KEYCLOAK_URL',
      'http://localhost:8080',
    );
    const realm = config.get<string>('KEYCLOAK_REALM', 'logchain');
    const issuer = `${keycloakUrl}/realms/${realm}`;

    // ตอนรันใน docker compose แอปเรียก http://localhost:8080 ไม่ถึง Keycloak
    // (localhost ในคอนเทนเนอร์ = ตัวมันเอง) ต้องเรียกผ่านชื่อ service `keycloak`
    // แต่ `iss` ในโทเคนเป็น URL ที่ "ฝั่งขอโทเคน" ใช้ ซึ่งคือ localhost:8080 เสมอ
    // เพราะเบราว์เซอร์/สคริปต์อยู่นอก network — เอามาปนกันไม่ได้
    //   KEYCLOAK_URL          = issuer ที่ต้อง match เป๊ะ (public URL)
    //   KEYCLOAK_INTERNAL_URL = ที่อยู่ที่ process นี้ยิงไปจริง (default = ตัวบน)
    // ปล่อยว่างใน .env ถือว่า "ไม่ได้ตั้ง" — ConfigService มองค่าว่างเป็นค่าที่ตั้งแล้ว
    // ถ้าไม่ดักตรงนี้ jwksUri จะกลายเป็น path เปล่า ๆ แล้ว verify ทุกโทเคนพัง
    const internalUrl = (
      config.get<string>('KEYCLOAK_INTERNAL_URL')?.trim() || keycloakUrl
    ).replace(/\/+$/, '');

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      algorithms: ['RS256'],
      issuer,
      // ดึง public key จาก JWKS endpoint ของ Keycloak (cache ไว้)
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 10,
        jwksUri: `${internalUrl}/realms/${realm}/protocol/openid-connect/certs`,
      }),
    });
  }

  validate(payload: KeycloakJwtPayload) {
    if (!payload?.sub) throw new UnauthorizedException('Invalid token');

    // attach เป็น req.user ให้ RolesGuard อ่าน user.roles ได้
    return {
      userId: payload.sub,
      username: payload.preferred_username,
      email: payload.email,
      roles: payload.roles ?? [],
    };
  }
}
