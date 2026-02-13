'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type {
  CopyProfileInfo,
  FollowInfo,
  LeaderInfo,
  LeaderEventInfo,
  OrderInfo,
  PositionInfo,
  ProvisioningStatus,
  SystemStatus,
  PaginatedResponse,
  UserProfile,
  WalletInfo,
  AutoClaimSettingsInfo,
} from '@mirrormarkets/shared';

// User
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<UserProfile>('/wallets/me'),
    enabled: !!api.getToken(),
  });
}

export function useMyWallets() {
  return useQuery({
    queryKey: ['me', 'wallets'],
    queryFn: () => api.get<WalletInfo[]>('/wallets/me/wallets'),
    enabled: !!api.getToken(),
  });
}

export function useProvisioningStatus() {
  return useQuery({
    queryKey: ['provisioning-status'],
    queryFn: () => api.get<ProvisioningStatus>('/wallets/me/provisioning-status'),
    enabled: !!api.getToken(),
    refetchInterval: 5000,
  });
}

export function useProvision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dynamicEoaAddress: string) =>
      api.post<ProvisioningStatus>('/wallets/provision', { dynamicEoaAddress }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['provisioning-status'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

// Leaders
export function useLeaderboard() {
  return useQuery({
    queryKey: ['leaderboard'],
    queryFn: () => api.get<any[]>('/leaders/leaderboard'),
    staleTime: 60_000,
  });
}

export function useLeader(leaderId: string) {
  return useQuery({
    queryKey: ['leader', leaderId],
    queryFn: () => api.get<LeaderInfo>(`/leaders/${leaderId}`),
    enabled: !!leaderId,
  });
}

export function useLeaderEvents(leaderId: string, page = 1) {
  return useQuery({
    queryKey: ['leader-events', leaderId, page],
    queryFn: () => api.get<PaginatedResponse<LeaderEventInfo>>(`/leaders/${leaderId}/events?page=${page}&pageSize=10`),
    enabled: !!leaderId,
  });
}

// Follows
export function useFollows() {
  return useQuery({
    queryKey: ['follows'],
    queryFn: () => api.get<FollowInfo[]>('/follows'),
    enabled: !!api.getToken(),
  });
}

export function useCreateFollow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (leaderAddress: string) =>
      api.post('/follows', { leaderAddress }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['follows'] }),
  });
}

export function useRemoveFollow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (followId: string) => api.delete(`/follows/${followId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['follows'] }),
  });
}

// Copy Profile
export function useCopyProfile() {
  return useQuery({
    queryKey: ['copy-profile'],
    queryFn: () => api.get<CopyProfileInfo>('/copy/profile'),
  });
}

export function useUpdateCopyProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<CopyProfileInfo>) => api.put('/copy/profile', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['copy-profile'] }),
  });
}

export function useEnableCopy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/copy/enable'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['copy-profile'] }),
  });
}

export function useDisableCopy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/copy/disable'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['copy-profile'] }),
  });
}

// Copy Logs
export function useCopyLogs(page = 1) {
  return useQuery({
    queryKey: ['copy-logs', page],
    queryFn: () => api.get<PaginatedResponse<any>>(`/copy/logs?page=${page}`),
    refetchInterval: 10_000,
  });
}

export function useCopyLogsForLeader(leaderId: string, page = 1) {
  return useQuery({
    queryKey: ['copy-logs', 'leader', leaderId, page],
    queryFn: () => api.get<PaginatedResponse<any>>(`/copy/logs?leaderId=${leaderId}&page=${page}&pageSize=10`),
    enabled: !!leaderId,
    refetchInterval: 10_000,
  });
}

// Orders
export function useOrders(page = 1) {
  return useQuery({
    queryKey: ['orders', page],
    queryFn: () => api.get<PaginatedResponse<OrderInfo>>(`/orders?page=${page}`),
  });
}

export function useCancelOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderId: string) => api.post(`/orders/${orderId}/cancel`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }),
  });
}

// Portfolio
export function useBalances() {
  return useQuery({
    queryKey: ['balances'],
    queryFn: () => api.get<{ usdc: number; positions: number; total: number }>('/portfolio/balances'),
    enabled: !!api.getToken(),
    refetchInterval: 30_000,
  });
}

export function usePositions() {
  return useQuery({
    queryKey: ['positions'],
    queryFn: () => api.get<PositionInfo[]>('/portfolio/positions'),
  });
}

// Funds
export function useDepositAddress() {
  return useQuery({
    queryKey: ['deposit-address'],
    queryFn: () => api.get<{ address: string; chain: string; token: string }>('/funds/deposit-address'),
  });
}

export function useCreateWithdrawal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { amount: number; destinationAddr: string }) =>
      api.post('/funds/withdrawals', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['balances'] });
      qc.invalidateQueries({ queryKey: ['withdrawals'] });
    },
  });
}

export function useWithdrawals(page = 1) {
  return useQuery({
    queryKey: ['withdrawals', page],
    queryFn: () => api.get<PaginatedResponse<any>>(`/funds/withdrawals?page=${page}`),
  });
}

// Claims
export function useClaimable() {
  return useQuery({
    queryKey: ['claimable'],
    queryFn: () => api.get<any[]>('/claims/claimable'),
  });
}

export function useRedeem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (conditionId: string) => api.post('/claims/redeem', { conditionId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['claimable'] });
      qc.invalidateQueries({ queryKey: ['balances'] });
    },
  });
}

export function useAutoClaimSettings() {
  return useQuery({
    queryKey: ['auto-claim'],
    queryFn: () => api.get<AutoClaimSettingsInfo>('/claims/auto-claim'),
  });
}

export function useUpdateAutoClaim() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { enabled: boolean; minClaimableUsd?: number }) =>
      api.put('/claims/auto-claim', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['auto-claim'] }),
  });
}

// System
export function useSystemStatus() {
  return useQuery({
    queryKey: ['system-status'],
    queryFn: () => api.get<SystemStatus>('/system/status'),
    refetchInterval: 60_000,
  });
}
