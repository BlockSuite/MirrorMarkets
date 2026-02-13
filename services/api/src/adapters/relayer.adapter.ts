import { Interface, getBytes, keccak256, toUtf8Bytes } from 'ethers';
import type { TradingAuthorityProvider } from '@mirrormarkets/shared';
import { POLYMARKET_CONTRACTS, POLYMARKET_URLS } from '@mirrormarkets/shared';

/**
 * RelayerAdapter — Phase 2A
 *
 * Submits gasless transactions via the Polymarket relayer.
 * All signing is done through the TradingAuthorityProvider — no raw keys.
 *
 * [DVC-7] Verify that the relayer accepts signatures from a non-local
 * signer (i.e., the signed message can be produced by signMessage on
 * the Dynamic server wallet and still be accepted).
 */
export class RelayerAdapter {
  constructor(
    private tradingAuthority: TradingAuthorityProvider,
    private userId: string,
    private tradingAddress: string,
    private proxyAddress: string,
  ) {}

  async approveAndDeposit(amountUsdcRaw: bigint): Promise<string> {
    const payload = {
      type: 'PROXY',
      from: this.tradingAddress,
      proxy: this.proxyAddress,
      transactions: [
        {
          to: POLYMARKET_CONTRACTS.USDC,
          data: this.encodeApprove(POLYMARKET_CONTRACTS.CTF_EXCHANGE, amountUsdcRaw),
        },
      ],
    };

    const messageHash = getBytes(
      keccak256(toUtf8Bytes(JSON.stringify(payload))),
    );
    const signature = await this.tradingAuthority.signMessage(this.userId, messageHash);

    const res = await fetch(`${POLYMARKET_URLS.RELAYER}/relay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, signature }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Relayer deposit failed: ${res.status} ${body}`);
    }

    const result = (await res.json()) as { transactionHash: string };
    return result.transactionHash;
  }

  async withdraw(amountUsdcRaw: bigint, destination: string): Promise<string> {
    const payload = {
      type: 'PROXY',
      from: this.tradingAddress,
      proxy: this.proxyAddress,
      transactions: [
        {
          to: POLYMARKET_CONTRACTS.USDC,
          data: this.encodeTransfer(destination, amountUsdcRaw),
        },
      ],
    };

    const messageHash = getBytes(
      keccak256(toUtf8Bytes(JSON.stringify(payload))),
    );
    const signature = await this.tradingAuthority.signMessage(this.userId, messageHash);

    const res = await fetch(`${POLYMARKET_URLS.RELAYER}/relay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, signature }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Relayer withdrawal failed: ${res.status} ${body}`);
    }

    const result = (await res.json()) as { transactionHash: string };
    return result.transactionHash;
  }

  async redeemPositions(conditionId: string): Promise<string> {
    const iface = new Interface([
      'function redeemPositions(bytes32 conditionId, uint256[] indexSets)',
    ]);

    const data = iface.encodeFunctionData('redeemPositions', [
      conditionId,
      [1, 2],
    ]);

    const payload = {
      type: 'PROXY',
      from: this.tradingAddress,
      proxy: this.proxyAddress,
      transactions: [
        {
          to: POLYMARKET_CONTRACTS.CONDITIONAL_TOKENS,
          data,
        },
      ],
    };

    const messageHash = getBytes(
      keccak256(toUtf8Bytes(JSON.stringify(payload))),
    );
    const signature = await this.tradingAuthority.signMessage(this.userId, messageHash);

    const res = await fetch(`${POLYMARKET_URLS.RELAYER}/relay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, signature }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Relayer redeem failed: ${res.status} ${body}`);
    }

    const result = (await res.json()) as { transactionHash: string };
    return result.transactionHash;
  }

  private encodeApprove(spender: string, amount: bigint): string {
    const iface = new Interface(['function approve(address spender, uint256 amount)']);
    return iface.encodeFunctionData('approve', [spender, amount]);
  }

  private encodeTransfer(to: string, amount: bigint): string {
    const iface = new Interface(['function transfer(address to, uint256 amount)']);
    return iface.encodeFunctionData('transfer', [to, amount]);
  }
}
