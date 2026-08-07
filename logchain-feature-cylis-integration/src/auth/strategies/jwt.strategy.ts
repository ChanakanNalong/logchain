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
    const keycloakUrl = config.get<string>('KEYCLOAK_URL', 'http://localhost:8080');
    const realm = config.get<string>('KEYCLOAK_REALM', 'logchain');
    const issuer = `${keycloakUrl}/realms/${realm}`;

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
        jwksUri: `${issuer}/protocol/openid-connect/certs`,
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
