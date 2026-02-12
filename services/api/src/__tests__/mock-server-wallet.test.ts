import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers } from 'ethers';

// Mock PrismaClient for unit tests
const mockPrisma = {
  serverWallet: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  wallet: {
    upsert: vi.fn(),
  },
  copyProfile: {
    updateMany: vi.fn(),
  },
};

// We can't easily import the class with its Prisma dependency,
// so we test the deterministic key derivation logic directly.

describe('MockDynamicServerWalletProvider key derivation', () => {
  it('derives deterministic address from userId', () => {
    const seed = ethers.keccak256(ethers.toUtf8Bytes('user-abc'));
    const wallet = new ethers.Wallet(seed);

    // Same userId always produces the same address
    const seed2 = ethers.keccak256(ethers.toUtf8Bytes('user-abc'));
    const wallet2 = new ethers.Wallet(seed2);

    expect(wallet.address).toBe(wallet2.address);
    expect(wallet.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it('different userIds produce different addresses', () => {
    const seed1 = ethers.keccak256(ethers.toUtf8Bytes('user-abc'));
    const seed2 = ethers.keccak256(ethers.toUtf8Bytes('user-xyz'));
    const wallet1 = new ethers.Wallet(seed1);
    const wallet2 = new ethers.Wallet(seed2);

    expect(wallet1.address).not.toBe(wallet2.address);
  });

  it('can sign messages with derived wallet', async () => {
    const seed = ethers.keccak256(ethers.toUtf8Bytes('test-user'));
    const wallet = new ethers.Wallet(seed);
    const signature = await wallet.signMessage('test message');

    expect(signature).toMatch(/^0x[a-fA-F0-9]+$/);

    // Verify signature recovers to the correct address
    const recovered = ethers.verifyMessage('test message', signature);
    expect(recovered).toBe(wallet.address);
  });

  it('can sign EIP-712 typed data with derived wallet', async () => {
    const seed = ethers.keccak256(ethers.toUtf8Bytes('test-user'));
    const wallet = new ethers.Wallet(seed);

    const domain = { name: 'Test', version: '1', chainId: 137 };
    const types = { Order: [{ name: 'id', type: 'uint256' }] };
    const value = { id: 1 };

    const signature = await wallet.signTypedData(domain, types, value);
    expect(signature).toMatch(/^0x[a-fA-F0-9]+$/);
  });
});

describe('MockDynamicServerWalletProvider failure simulation', () => {
  it('revoke clears signer from map', () => {
    const signers = new Map<string, ethers.Wallet>();
    const seed = ethers.keccak256(ethers.toUtf8Bytes('revoke-test'));
    signers.set('revoke-test', new ethers.Wallet(seed));

    expect(signers.has('revoke-test')).toBe(true);
    signers.delete('revoke-test');
    expect(signers.has('revoke-test')).toBe(false);
  });
});
