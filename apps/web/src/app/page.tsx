'use client';

import { useDynamicContext, getAuthToken } from '@dynamic-labs/sdk-react-core';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { api } from '@/lib/api-client';

export default function HomePage() {
  const { user, handleLogOut, setShowAuthFlow } = useDynamicContext();
  const router = useRouter();

  useEffect(() => {
    if (!user) return;

    // Already have a backend session — go to dashboard
    if (api.getToken()) {
      router.replace('/dashboard');
      return;
    }

    // User is authenticated with Dynamic but has no backend session.
    // Poll for the Dynamic JWT (may not be available immediately) and verify.
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const tryVerify = async (): Promise<boolean> => {
      const jwt = getAuthToken();
      console.log('[auth] tryVerify - jwt:', jwt ? `present (${jwt.substring(0, 20)}...)` : 'null');
      if (!jwt || cancelled) return false;

      try {
        const res = await api.post<{ token: string }>('/auth/dynamic/verify', { token: jwt });
        if (!cancelled) {
          api.setToken(res.token);
          window.location.href = '/dashboard';
        }
        return true;
      } catch (err) {
        console.error('Auth verify failed:', err);
        return false;
      }
    };

    // Try immediately, then poll every 300ms until the JWT is available
    tryVerify().then((ok) => {
      if (ok || cancelled) return;
      intervalId = setInterval(async () => {
        const ok = await tryVerify();
        if (ok || cancelled) clearInterval(intervalId);
      }, 300);
      timeoutId = setTimeout(() => {
        cancelled = true;
        clearInterval(intervalId);
      }, 15_000);
    });

    return () => {
      cancelled = true;
      clearInterval(intervalId);
      clearTimeout(timeoutId);
    };
  }, [user, router]);

  const onLogout = async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      // Ignore errors — session may already be expired
    }
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
          <p className="text-gray-600 dark:text-gray-400">
            Signing in...
          </p>
        )}
      </div>
    </div>
  );
}
