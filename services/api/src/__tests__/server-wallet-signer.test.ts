import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServerWalletSigner } from '../adapters/server-wallet-signer.js';
import type { TradingAuthorityProvider, EIP712TypedData } from '@mirrormarkets/shared';

describe('ServerWalletSigner', () => {
  let mockProvider: TradingAuthorityProvider;
  let signer: ServerWalletSigner;
  const userId = 'test-user-123';
  const address = '0x1234567890abcdef1234567890abcdef12345678';

  beforeEach(() => {
    mockProvider = {
      getAddress: vi.fn().mockResolvedValue(address),
      signTypedData: vi.fn().mockResolvedValue('0xsig-typed'),
      signMessage: vi.fn().mockResolvedValue('0xsig-message'),
    };
    signer = new ServerWalletSigner(mockProvider, userId, address);
  });

  it('getAddress returns the provided address', async () => {
    expect(await signer.getAddress()).toBe(address);
  });

  it('signMessage delegates to provider', async () => {
    const signature = await signer.signMessage('hello');
    expect(signature).toBe('0xsig-message');
    expect(mockProvider.signMessage).toHaveBeenCalledWith(userId, 'hello');
  });

  it('signMessage accepts Uint8Array', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await signer.signMessage(bytes);
    expect(mockProvider.signMessage).toHaveBeenCalledWith(userId, bytes);
  });

  it('_signTypedData delegates to provider with correct EIP712TypedData', async () => {
    const domain = { name: 'Test', version: '1', chainId: 137 };
    const types = {
      Order: [
        { name: 'tokenId', type: 'string' },
        { name: 'amount', type: 'uint256' },
      ],
    };
    const value = { tokenId: 'abc', amount: '100' };

    const signature = await signer._signTypedData(domain, types, value);

    expect(signature).toBe('0xsig-typed');
    expect(mockProvider.signTypedData).toHaveBeenCalledWith(userId, {
      types,
      primaryType: 'Order',
      domain,
      message: value,
    });
  });

  it('signTypedData is an alias for _signTypedData', async () => {
    const domain = { name: 'Test' };
    const types = { Order: [{ name: 'id', type: 'uint256' }] };
    const value = { id: '1' };

    await signer.signTypedData(domain, types, value);
    expect(mockProvider.signTypedData).toHaveBeenCalledTimes(1);
  });

  it('connect returns self', () => {
    expect(signer.connect()).toBe(signer);
  });

  it('provider field is null', () => {
    expect(signer.provider).toBeNull();
  });

  it('filters out EIP712Domain from types', async () => {
    const domain = { name: 'Test' };
    const types = {
      EIP712Domain: [{ name: 'name', type: 'string' }],
      Order: [{ name: 'id', type: 'uint256' }],
    };
    const value = { id: '1' };

    await signer._signTypedData(domain, types, value);

    const calledWith = (mockProvider.signTypedData as any).mock.calls[0][1] as EIP712TypedData;
    expect(calledWith.types).not.toHaveProperty('EIP712Domain');
    expect(calledWith.types).toHaveProperty('Order');
    expect(calledWith.primaryType).toBe('Order');
  });
});
