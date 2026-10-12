/**
 * Oturum durumu (tarayıcı tarafı).
 *
 * Tek doğruluk kaynağı sunucudur: `/api/auth/session` çerezi doğrular. Bu modül
 * yalnızca önbellek tutar ve giriş/çıkış eylemlerini sarmalar; kimlik bilgisi
 * tarayıcıda saklanmaz (oturum HttpOnly çerezdedir).
 *
 * Dışarıdan kayıt YOKTUR: hesap açma yalnızca yönetici davetiyle olur, bu yüzden
 * burada `register` eylemi bilinçli olarak bulunmaz.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createContext, createElement, useContext, useMemo } from 'react';
import { api } from './api';
import type { SessionResponse } from '../types';

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
  role: 'user' | 'admin';
  status: string;
  emailVerified: boolean;
  emailVerifiedAt: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

interface AuthContextValue {
  user: SessionUser | null;
  /** İlk yükleme sürüyor (oturum henüz doğrulanmadı). */
  loading: boolean;
  isAdmin: boolean;
  roleLabel: string;
  displayName: string;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Görünen ad: kayıtlı ad yoksa e-posta köküne düşer (psikolog ile aynı kural). */
export function displayNameOf(user: SessionUser | null): string {
  if (!user) return 'Ziyaretçi';
  const name = user.displayName?.trim();
  if (name && name.length > 0) return name;
  const local = user.email.split('@')[0] ?? 'kullanıcı';
  return local.charAt(0).toUpperCase() + local.slice(1);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<SessionResponse>('/api/auth/session'),
    staleTime: 30_000,
    retry: 0,
  });

  const login = useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      api.post<{ user: SessionUser }>('/api/auth/login', input),
    onSuccess: () => {
      void queryClient.invalidateQueries();
    },
  });

  const logout = useMutation({
    mutationFn: () => api.post<{ message: string }>('/api/auth/logout'),
    onSuccess: () => {
      void queryClient.invalidateQueries();
    },
  });

  const value = useMemo<AuthContextValue>(() => {
    const user = session.data?.user ?? null;
    return {
      user,
      loading: session.isLoading,
      isAdmin: user?.role === 'admin',
      roleLabel: user?.role === 'admin' ? 'Yönetici' : user ? 'Kayıtlı kullanıcı' : 'Ziyaretçi',
      displayName: displayNameOf(user),
      login: async (email, password) => {
        await login.mutateAsync({ email, password });
      },
      logout: async () => {
        await logout.mutateAsync();
      },
    };
  }, [session.data, session.isLoading, login, logout]);

  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth yalnızca SessionProvider içinde kullanılabilir.');
  return context;
}
