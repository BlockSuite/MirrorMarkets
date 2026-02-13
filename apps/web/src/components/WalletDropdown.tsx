'use client';

import { useState, useRef, useEffect } from 'react';
import { useDynamicContext } from '@dynamic-labs/sdk-react-core';
import { Copy, Check, LogOut, Wallet, ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { useMe, useMyWallets, useBalances } from '@/hooks/useApi';
import { shortenAddress, formatUsd } from '@mirrormarkets/shared';
import { api } from '@/lib/api-client';

export function WalletDropdown() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { user: dynamicUser, handleLogOut } = useDynamicContext();
  const { data: me, isLoading: meLoading } = useMe();
  const { data: wallets, isLoading: walletsLoading } = useMyWallets();
  const { data: balances } = useBalances();

  const primaryWallet = wallets?.find((w) => w.type === 'POLY_PROXY') ?? wallets?.find((w) => w.type === 'DYNAMIC_EOA');
  const address = primaryWallet?.address;

  // Fallback to Dynamic SDK user info while API data loads
  const displayName = me?.name ?? me?.email ?? dynamicUser?.email ?? 'User';
  const displayEmail = me?.email ?? dynamicUser?.email;
  const hasToken = !!api.getToken();

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleCopy = () => {
    if (!address) return;
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const onLogout = async () => {
    api.setToken(null);
    await handleLogOut();
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm transition hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:hover:bg-gray-800"
      >
        {me?.avatarUrl ? (
          <img src={me.avatarUrl} alt="" className="h-6 w-6 rounded-full" />
        ) : (
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-600">
            {displayName[0]?.toUpperCase() ?? '?'}
          </div>
        )}
        <span className="hidden text-gray-700 dark:text-gray-300 sm:inline">
          {address ? shortenAddress(address) : hasToken && walletsLoading ? 'Loading...' : displayName}
        </span>
        <ChevronDown className="h-4 w-4 text-gray-400" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-72 rounded-lg border border-gray-200 bg-white p-4 shadow-lg dark:border-gray-800 dark:bg-gray-900">
          {/* User info */}
          <div className="mb-3 border-b border-gray-100 pb-3 dark:border-gray-800">
            <p className="text-sm font-medium text-gray-900 dark:text-white">
              {displayName}
            </p>
            {displayEmail && displayName !== displayEmail && (
              <p className="text-xs text-gray-500">{displayEmail}</p>
            )}
          </div>

          {/* Wallet address */}
          {address && (
            <div className="mb-3">
              <p className="mb-1 text-xs text-gray-500">Wallet Address</p>
              <div className="flex items-center gap-2 rounded bg-gray-50 px-2 py-1.5 dark:bg-gray-800">
                <code className="flex-1 text-xs text-gray-700 dark:text-gray-300">
                  {shortenAddress(address, 8)}
                </code>
                <button
                  onClick={handleCopy}
                  className="shrink-0 text-gray-400 hover:text-gray-600"
                >
                  {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>
          )}

          {/* Balances */}
          {balances && (
            <div className="mb-3 border-b border-gray-100 pb-3 dark:border-gray-800">
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">USDC</span>
                <span className="font-medium text-gray-900 dark:text-white">{formatUsd(balances.usdc)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Portfolio</span>
                <span className="font-medium text-gray-900 dark:text-white">{formatUsd(balances.total)}</span>
              </div>
            </div>
          )}

          {/* Links */}
          <div className="space-y-1">
            <Link
              href="/dashboard/funds"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              <Wallet className="h-4 w-4" />
              Funds
            </Link>
            <button
              onClick={onLogout}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
