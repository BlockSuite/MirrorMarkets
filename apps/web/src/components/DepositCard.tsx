'use client';

import { useState } from 'react';
import { Copy, Check, CheckCircle, Circle, Loader2 } from 'lucide-react';
import { useProvisioningStatus, useProvision } from '@/hooks/useApi';

interface Props {
  address: string | null;
}

export function DepositCard({ address }: Props) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!address) return;
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
      <h3 className="mb-2 text-lg font-semibold text-gray-900 dark:text-white">Deposit USDC</h3>
      <p className="mb-4 text-sm text-gray-500">
        Send USDC on Polygon to your proxy wallet address below.
      </p>

      {address ? (
        <div className="flex items-center gap-2 rounded-lg bg-gray-50 p-3 dark:bg-gray-800">
          <code className="flex-1 break-all text-xs text-gray-700 dark:text-gray-300">
            {address}
          </code>
          <button
            onClick={handleCopy}
            className="shrink-0 rounded p-1 text-gray-400 hover:text-gray-600"
          >
            {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
          </button>
        </div>
      ) : (
        <ProvisioningChecklist />
      )}
    </div>
  );
}

function ProvisioningChecklist() {
  const { data: status, isLoading } = useProvisioningStatus();
  const provision = useProvision();

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        Checking account status...
      </div>
    );
  }

  if (!status) {
    return <p className="text-sm text-gray-400">Unable to check account status.</p>;
  }

  const steps = [
    {
      label: 'Create server wallet',
      done: status.serverWalletReady,
      inProgress: status.serverWalletCreating,
      action: !status.serverWallet
        ? () => provision.mutate()
        : undefined,
      actionLabel: 'Create',
    },
    {
      label: 'Proxy wallet ready',
      done: status.polyProxy,
      inProgress: status.serverWalletReady && !status.polyProxy,
    },
  ];

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-500">Complete these steps to get your deposit address:</p>
      {steps.map((step, i) => (
        <div key={i} className="flex items-center gap-3">
          {step.done ? (
            <CheckCircle className="h-5 w-5 shrink-0 text-green-500" />
          ) : step.inProgress ? (
            <Loader2 className="h-5 w-5 shrink-0 animate-spin text-brand-500" />
          ) : (
            <Circle className="h-5 w-5 shrink-0 text-gray-300" />
          )}
          <span className={`flex-1 text-sm ${step.done ? 'text-gray-400 line-through' : 'text-gray-700 dark:text-gray-300'}`}>
            {step.label}
          </span>
          {step.action && !step.done && !step.inProgress && (
            <button
              onClick={step.action}
              disabled={provision.isPending}
              className="rounded border border-brand-600 px-3 py-1 text-xs font-medium text-brand-600 hover:bg-brand-50 disabled:opacity-50 dark:hover:bg-brand-900/20"
            >
              {provision.isPending ? 'Creating...' : step.actionLabel}
            </button>
          )}
          {step.inProgress && (
            <span className="text-xs text-gray-400">Setting up...</span>
          )}
        </div>
      ))}
    </div>
  );
}
