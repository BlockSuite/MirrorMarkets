'use client';

import { useDynamicContext, getAuthToken } from '@dynamic-labs/sdk-react-core';
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { api } from '@/lib/api-client';

export default function HomePage() {
  const { user, handleLogOut, setShowAuthFlow } = useDynamicContext();
  const router = useRouter();
  const verifying = useRef(false);

  // When Dynamic user is present, verify with backend and redirect
  useEffect(() => {
    if (!user) return;

    // If we already have a valid session token, go straight to dashboard
    if (api.getToken()) {
      router.replace('/dashboard');
      return;
    }

    // Get the Dynamic JWT and verify with our backend
    const dynamicJwt = getAuthToken();
    if (!dynamicJwt || verifying.current) return;

    verifying.current = true;
    api
      .post<{ token: string }>('/auth/dynamic/verify', { token: dynamicJwt })
      .then((res) => {
        api.setToken(res.token);
        router.push('/dashboard');
      })
      .catch((err) => {
        console.error('Auth verify failed:', err);
        verifying.current = false;
      });
  }, [user, router]);

  const onLogout = async () => {
    api.setToken(null);
    await handleLogOut();
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="max-w-md text-center">
        <h1 className="mb-2 text-4xl font-bold tracking-tight text-gray-900 dark:text-white">
          Mirror Markets
        </h1>
        <p className="mb-8 text-lg text-gray-600 dark:text-gray-400">
          Copy trade the best Polymarket traders automatically.
        </p>

        {!user ? (
          <button
            onClick={() => setShowAuthFlow(true)}
            className="rounded-lg bg-brand-600 px-8 py-3 text-lg font-semibold text-white shadow-sm transition hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
          >
            Sign in with Email
          </button>
        ) : (
          <div className="space-y-4">
            <p className="text-gray-600 dark:text-gray-400">
              Signed in as {user.email}
            </p>
            <div className="flex gap-3 justify-center">
              <button
                onClick={() => router.push('/dashboard')}
                className="rounded-lg bg-brand-600 px-6 py-2 font-semibold text-white hover:bg-brand-700"
              >
                Dashboard
              </button>
              <button
                onClick={onLogout}
                className="rounded-lg border border-gray-300 px-6 py-2 font-semibold text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                Sign out
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
