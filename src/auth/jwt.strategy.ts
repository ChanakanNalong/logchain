import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: 'http://localhost:8080/realms/logchain/protocol/openid-connect/certs',
      }),
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      issuer: 'http://localhost:8080/realms/logchain',
      algorithms: ['RS256'],
    });
  }

  validate(payload: any) {
    return {
      userId: payload.sub,
      username: payload.preferred_username,
      roles: payload.resource_access?.['logchain-api']?.roles ?? [],
    };
  }
}
