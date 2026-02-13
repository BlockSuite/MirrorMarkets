'use client';

import { DynamicContextProvider, getAuthToken } from '@dynamic-labs/sdk-react-core';
import { EthereumWalletConnectors } from '@dynamic-labs/ethereum';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api-client';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: 1,
          },
        },
      }),
  );

  return (
    <DynamicContextProvider
      settings={{
        environmentId: process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID ?? '',
        walletConnectors: [EthereumWalletConnectors],
        events: {
          onAuthSuccess: async ({ user: authUser }) => {
            // Dynamic auth complete — verify with our backend and get a session token
            const dynamicJwt = getAuthToken();
            console.log('[auth] onAuthSuccess fired, user:', authUser?.email, 'jwt:', dynamicJwt ? 'present' : 'null', 'existingToken:', !!api.getToken());
            if (!dynamicJwt || api.getToken()) return;

            try {
              const res = await api.post<{ token: string; dynamicEoaAddress?: string | null }>('/auth/dynamic/verify', { token: dynamicJwt });
              api.setToken(res.token);
              // Auto-provision wallet
              try {
                await api.post('/wallets/provision', {
                  dynamicEoaAddress: res.dynamicEoaAddress ?? undefined,
                });
              } catch {
                // Continue even if provisioning fails
              }
              window.location.href = '/dashboard';
            } catch (err) {
              console.error('Backend auth verify failed:', err);
            }
          },
        },
      }}
    >
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </DynamicContextProvider>
  );
}
