'use client';

import { useProvisioningStatus, useProvision } from '@/hooks/useApi';
import { useDynamicContext } from '@dynamic-labs/sdk-react-core';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { CheckCircle2, Circle, Loader2 } from 'lucide-react';

const STEPS = [
  { key: 'dynamicEoa', label: 'Create identity wallet' },
  { key: 'tradingEoa', label: 'Generate trading wallet' },
  { key: 'polyProxy', label: 'Set up Polymarket proxy' },
  { key: 'clobApiKey', label: 'Derive API credentials' },
  { key: 'copyProfile', label: 'Initialize copy profile' },
] as const;

export default function OnboardingPage() {
  const { data: status, isLoading } = useProvisioningStatus();
  const provision = useProvision();
  const router = useRouter();

  useEffect(() => {
    if (status?.complete) {
      router.push('/dashboard');
    }
  }, [status?.complete, router]);

  const handleProvision = () => {
    provision.mutate();
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md">
        <h1 className="mb-2 text-2xl font-bold text-gray-900 dark:text-white">
          Account Setup
        </h1>
        <p className="mb-8 text-gray-600 dark:text-gray-400">
          We need to set up your trading infrastructure. This only happens once.
        </p>

        <div className="mb-8 space-y-4">
          {STEPS.map(({ key, label }) => {
            const done = status?.[key] ?? false;
            return (
              <div key={key} className="flex items-center gap-3">
                {done ? (
                  <CheckCircle2 className="h-5 w-5 text-green-500" />
                ) : provision.isPending ? (
                  <Loader2 className="h-5 w-5 animate-spin text-brand-500" />
                ) : (
                  <Circle className="h-5 w-5 text-gray-300" />
                )}
                <span className={done ? 'text-gray-900 dark:text-white' : 'text-gray-500'}>
                  {label}
                </span>
              </div>
            );
          })}
        </div>

        {!status?.complete && (
          <button
            onClick={handleProvision}
            disabled={provision.isPending || isLoading}
            className="w-full rounded-lg bg-brand-600 px-4 py-3 font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {provision.isPending ? 'Setting up...' : 'Start Setup'}
          </button>
        )}

        {provision.isError && (
          <p className="mt-4 text-sm text-red-500">
            Setup failed. Please try again.
          </p>
        )}
      </div>
    </div>
  );
}
