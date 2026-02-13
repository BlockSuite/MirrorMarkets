import * as jose from 'jose';
import { getConfig } from '../config.js';
import { UnauthorizedError } from '@mirrormarkets/shared';

export interface DynamicJwtPayload {
  sub: string; // Dynamic user ID
  email: string;
  environment_id: string;
  verified_credentials: Array<{
    address?: string;
    chain?: string;
    wallet_name?: string;
    format?: string;
  }>;
}

export class DynamicAdapter {
  private publicKey: jose.KeyLike | null = null;

  async verifyToken(token: string): Promise<DynamicJwtPayload> {
    const config = getConfig();

    try {
      if (!this.publicKey) {
        if (!config.DYNAMIC_PUBLIC_KEY) {
          throw new Error('DYNAMIC_PUBLIC_KEY is not configured');
        }
        this.publicKey = await jose.importSPKI(config.DYNAMIC_PUBLIC_KEY, 'RS256');
      }

      const { payload } = await jose.jwtVerify(token, this.publicKey);

      const dynamicPayload = payload as unknown as DynamicJwtPayload;

      if (dynamicPayload.environment_id !== config.DYNAMIC_ENVIRONMENT_ID) {
        throw new UnauthorizedError('Invalid environment');
      }

      return dynamicPayload;
    } catch (error) {
      if (error instanceof UnauthorizedError) throw error;
      throw new UnauthorizedError('Invalid Dynamic JWT');
    }
  }
}
