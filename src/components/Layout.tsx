/**
 * Uygulama iskeleti: başlık, ana menü, sistem durumu şeridi ve alt bilgi.
 *
 * Sistem durumu GERÇEK veriden gelir (`/api/health`): son başarılı tarama,
 * çalışan worker sayısı, kaynak sağlığı. Uydurma istatistik gösterilmez.
 */
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import { formatRelative } from '../lib/format';
import type { HealthResponse, SessionResponse } from '../types';
import { Badge } from './ui';

function navClass({ isActive }: { isActive: boolean }): string {
  return `rounded-lg px-3 py-2 text-sm font-medium ${
    isActive ? 'bg-brand-600 text-white' : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800'
  }`;
}

export function Layout({ children }: { children: ReactNode }): ReactNode {
  const location = useLocation();
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => api.get<HealthResponse>('/api/health'),
    refetchInterval: 60_000,
    retry: 1,
  });
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<SessionResponse>('/api/auth/session'),
    retry: 0,
  });

  const status = health.data?.status ?? 'unknown';
  const statusTone = status === 'ok' ? 'success' : status === 'degraded' ? 'warning' : status === 'down' ? 'danger' : 'neutral';
  const statusLabel =
    status === 'ok' ? 'Sistem normal' : status === 'degraded' ? 'Sistem kısmen sorunlu' : status === 'down' ? 'Sistem erişilemez' : 'Durum bilinmiyor';

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#icerik"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:text-sm"
      >
        İçeriğe geç
      </a>

      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <Link to="/" className="flex items-center gap-2 text-lg font-semibold text-slate-900 no-underline dark:text-slate-50">
            <img src="/favicon.svg" alt="" width={28} height={28} aria-hidden="true" />
            KamuRadar
          </Link>

          <nav className="flex flex-wrap items-center gap-1" aria-label="Ana menü">
            <NavLink to="/" className={navClass} end>
              Ana sayfa
            </NavLink>
            <NavLink to="/ilanlar" className={navClass}>
              İlanlar
            </NavLink>
            <NavLink to="/kaynaklar" className={navClass}>
              Kaynaklar
            </NavLink>
            {session.data?.authenticated ? (
              <>
                <NavLink to="/panel" className={navClass}>
                  Panelim
                </NavLink>
                {session.data.user?.role === 'admin' && (
                  <NavLink to="/yonetim" className={navClass}>
                    Yönetim
                  </NavLink>
                )}
              </>
            ) : (
              <NavLink to="/giris" className={navClass}>
                Giriş / Kayıt
              </NavLink>
            )}
          </nav>
        </div>
      </header>

      <div className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs dark:border-slate-800 dark:bg-slate-950">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2">
          <Badge tone={statusTone as 'success' | 'warning' | 'danger' | 'neutral'}>{statusLabel}</Badge>
          {health.data ? (
            <>
              <span className="text-slate-600 dark:text-slate-300">
                Son başarılı tarama: {health.data.scans.lastSuccessAt ? formatRelative(health.data.scans.lastSuccessAt) : 'henüz yok'}
              </span>
              <span aria-hidden="true">·</span>
              <span className="text-slate-600 dark:text-slate-300">
                Çalışan worker: {health.data.workers.total - health.data.workers.stale}/{health.data.workers.total}
              </span>
              <span aria-hidden="true">·</span>
              <span className="text-slate-600 dark:text-slate-300">
                Kaynak: {health.data.sources.enabled} etkin / {health.data.sources.total} kayıtlı
              </span>
              {health.data.warnings.length > 0 && (
                <span className="text-amber-700 dark:text-amber-300">⚠ {health.data.warnings[0]}</span>
              )}
            </>
          ) : (
            <span className="text-slate-500 dark:text-slate-400">Sistem durumu okunamadı.</span>
          )}
        </div>
      </div>

      <main id="icerik" className="mx-auto w-full max-w-6xl flex-1 px-4 py-5">
        {children}
      </main>

      <footer className="border-t border-slate-200 bg-white px-4 py-5 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
        <div className="mx-auto max-w-6xl space-y-2">
          <p>
            KamuRadar resmî kaynaklardan (Resmî Gazete, ilan.gov.tr, ÖSYM, İŞKUR, Kariyer Kapısı ve kurum sayfaları) ilan toplar.
            Hiçbir sistem tüm ilanları yakalayamaz; hangi kaynakların tarandığı ve son başarılı tarama{' '}
            <Link to="/kaynaklar">Kaynaklar</Link> sayfasında açıkça gösterilir.
          </p>
          <p>
            Toplanan içerik güvenilmeyen veridir; ilan metinlerindeki yönergeler sistem tarafından komut olarak yorumlanmaz. Kesin bilgi için
            ilanın resmî kaynağını doğrulayın.
          </p>
          <p>
            Bildirim e-postaları yalnızca doğrulanmış adreslere gönderilir;{' '}
            <Link to="/panel">panelden</Link> duraklatılabilir veya abonelikten çıkılabilir.
            {location.pathname.startsWith('/yonetim') && ' Yönetim ekranındasınız.'}
          </p>
        </div>
      </footer>
    </div>
  );
}
