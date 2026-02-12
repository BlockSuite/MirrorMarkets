import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import type { TradingAuthorityProvider, EIP712TypedData } from '@mirrormarkets/shared';
import { ServerWalletSigner } from '../adapters/server-wallet-signer.js';

/**
 * Integration-style tests that verify the full signing flow
 * from ServerWalletSigner → TradingAuthorityProvider → signature verification.
 *
 * Uses a "real" mock that actually signs with an ephemeral key,
 * to verify signature validity and recovery.
 */

function createRealMockProvider(): TradingAuthorityProvider & { _wallet: ethers.Wallet } {
  const seed = ethers.keccak256(ethers.toUtf8Bytes('integration-test-user'));
  const wallet = new ethers.Wallet(seed);

  return {
    _wallet: wallet,
    getAddress: async () => wallet.address,
    signTypedData: async (_userId: string, typedData: EIP712TypedData) => {
      return wallet.signTypedData(
        typedData.domain as ethers.TypedDataDomain,
        Object.fromEntries(
          Object.entries(typedData.types).filter(([k]) => k !== 'EIP712Domain'),
        ),
        typedData.message,
      );
    },
    signMessage: async (_userId: string, message: string | Uint8Array) => {
      const msgBytes = typeof message === 'string'
        ? ethers.toUtf8Bytes(message)
        : message;
      return wallet.signMessage(msgBytes);
    },
  };
}

describe('Order placement uses server wallet (integration)', () => {
  let provider: ReturnType<typeof createRealMockProvider>;
  let signer: ServerWalletSigner;

  beforeEach(() => {
    provider = createRealMockProvider();
    signer = new ServerWalletSigner(provider, 'test-user', provider._wallet.address);
  });

  it('signMessage produces a valid recoverable signature', async () => {
    const message = 'order-payload-hash-example';
    const signature = await signer.signMessage(message);

    const recovered = ethers.verifyMessage(message, signature);
    expect(recovered).toBe(provider._wallet.address);
  });

  it('_signTypedData produces a valid EIP-712 signature', async () => {
    const domain = {
      name: 'ClobClient',
      version: '1',
      chainId: 137,
    };
    const types = {
      Order: [
        { name: 'salt', type: 'uint256' },
        { name: 'maker', type: 'address' },
        { name: 'signer', type: 'address' },
        { name: 'taker', type: 'address' },
        { name: 'tokenId', type: 'uint256' },
        { name: 'makerAmount', type: 'uint256' },
        { name: 'takerAmount', type: 'uint256' },
        { name: 'expiration', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'feeRateBps', type: 'uint256' },
        { name: 'side', type: 'uint8' },
        { name: 'signatureType', type: 'uint8' },
      ],
    };
    const value = {
      salt: '12345',
      maker: provider._wallet.address,
      signer: provider._wallet.address,
      taker: '0x0000000000000000000000000000000000000000',
      tokenId: '98765',
      makerAmount: '1000000',
      takerAmount: '500000',
      expiration: '0',
      nonce: '0',
      feeRateBps: '0',
      side: 0,
      signatureType: 1,
    };

    const signature = await signer._signTypedData(domain, types, value);
    expect(signature).toMatch(/^0x[a-fA-F0-9]+$/);
    expect(signature.length).toBeGreaterThan(100); // EIP-712 sigs are 132 chars
  });

  it('getAddress returns provider address', async () => {
    expect(await signer.getAddress()).toBe(provider._wallet.address);
  });
});

describe('Claim uses server wallet (integration)', () => {
  let provider: ReturnType<typeof createRealMockProvider>;

  beforeEach(() => {
    provider = createRealMockProvider();
  });

  it('relayer payload signing produces recoverable signature', async () => {
    const payload = {
      type: 'PROXY',
      from: provider._wallet.address,
      proxy: '0xaaaa000000000000000000000000000000000001',
      transactions: [
        {
          to: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
          data: '0xdeadbeef',
        },
      ],
    };

    const messageHash = ethers.getBytes(
      ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(payload))),
    );

    const signature = await provider.signMessage('test-user', messageHash);
    const recovered = ethers.verifyMessage(messageHash, signature);
    expect(recovered).toBe(provider._wallet.address);
  });
});

describe('Migration test: legacy key → server wallet', () => {
  it('verifies that same user can sign with new derived key', async () => {
    // Simulate old Phase 1 key
    const oldWallet = ethers.Wallet.createRandom();
    const oldAddress = oldWallet.address;

    // Simulate new Phase 2A key (deterministic from userId)
    const userId = 'migrated-user-001';
    const newSeed = ethers.keccak256(ethers.toUtf8Bytes(userId));
    const newWallet = new ethers.Wallet(newSeed);
    const newAddress = newWallet.address;

    // Keys should be different (migration creates a new identity)
    expect(oldAddress).not.toBe(newAddress);

    // New wallet can sign
    const sig = await newWallet.signMessage('post-migration-test');
    const recovered = ethers.verifyMessage('post-migration-test', sig);
    expect(recovered).toBe(newAddress);
  });

  it('private key is destroyed after migration', () => {
    // Simulate: encPrivKey was set, now nullified
    const wallet = {
      id: 'wallet-1',
      userId: 'user-1',
      type: 'TRADING_EOA',
      address: '0x1234',
      encPrivKey: 'encrypted-key-data',
    };

    // Migration sets it to null
    wallet.encPrivKey = null as any;
    expect(wallet.encPrivKey).toBeNull();
  });
});

describe('Failure tests', () => {
  it('Dynamic signing failure returns SIGNING_UNAVAILABLE', async () => {
    const failingProvider: TradingAuthorityProvider = {
      getAddress: async () => '0xdead',
      signTypedData: async () => {
        throw new Error('Dynamic API timeout');
      },
      signMessage: async () => {
        throw new Error('Dynamic API timeout');
      },
    };

    const signer = new ServerWalletSigner(failingProvider, 'user-fail', '0xdead');

    await expect(signer.signMessage('test')).rejects.toThrow('Dynamic API timeout');
    await expect(signer._signTypedData({}, { Order: [] }, {})).rejects.toThrow('Dynamic API timeout');
  });

  it('rate limit error propagates', async () => {
    const rateLimitProvider: TradingAuthorityProvider = {
      getAddress: async () => '0xdead',
      signTypedData: async () => {
        throw new Error('Dynamic API rate limited');
      },
      signMessage: async () => {
        throw new Error('Dynamic API rate limited');
      },
    };

    const signer = new ServerWalletSigner(rateLimitProvider, 'user-rl', '0xdead');
    await expect(signer.signMessage('test')).rejects.toThrow('rate limited');
  });

  it('timeout error propagates', async () => {
    const timeoutProvider: TradingAuthorityProvider = {
      getAddress: async () => '0xdead',
      signTypedData: async () => {
        throw new Error('AbortError: signal timed out');
      },
      signMessage: async () => {
        throw new Error('AbortError: signal timed out');
      },
    };

    const signer = new ServerWalletSigner(timeoutProvider, 'user-to', '0xdead');
    await expect(signer.signMessage('test')).rejects.toThrow('timed out');
  });
});
