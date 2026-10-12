/**
 * Durum şeridi (üst bilgi altı).
 *
 * Kamuİlan'da "bulut senkronizasyonu" yoktur; burada gösterilen şey verinin
 * tazeliğidir: son başarılı taramanın üzerinden ne kadar geçti, worker çalışıyor
 * mu, kaç kaynak üst üste başarısız oldu. Sistem "tüm ilanlar burada" demez;
 * kapsam bilgisi aynı şeritte yazılır.
 *
 * Şerit kapatılabilir: kapatma yalnızca oturum belleğinde tutulur (sunucuya
 * yazılmaz), çünkü bu bir bilgilendirme metnidir.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { formatNumber, formatRelative } from '../lib/format';
import type { HealthResponse } from '../types';
import { Icon } from './Icon';

const DISMISS_KEY = 'kamuilan:status-banner-dismissed';

function readDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

export function StatusBanner() {
  const [dismissed, setDismissed] = useState(readDismissed);
  const health = useQuery({
    queryKey: ['health', 'banner'],
    queryFn: () => api.get<HealthResponse>('/api/health'),
    refetchInterval: 60_000,
    retry: 1,
  });

  if (dismissed) return null;
  if (health.isLoading || health.isError || !health.data) return null;

  const data = health.data;
  const minutes = data.scans.minutesSinceSuccess;
  const stale = minutes !== null && minutes > 24 * 60;
  const failing = data.sources.failing > 0;
  const noWorker = data.workers.running === 0;

  const tone = data.status === 'down' || stale || failing || noWorker ? 'warning' : 'info';
  const parts: string[] = [];
  parts.push(
    data.scans.lastSuccessAt
      ? `Son başarılı tarama ${formatRelative(data.scans.lastSuccessAt)}.`
      : 'Henüz başarılı tarama kaydı yok.',
  );
  parts.push(`${formatNumber(data.sources.enabled)} kaynak etkin, ${formatNumber(data.sources.built ?? 0)} adaptör yazılmış.`);
  if (failing) parts.push(`${formatNumber(data.sources.failing)} kaynak üst üste başarısız.`);
  if (noWorker) parts.push('Çalışan worker yok: yeni tarama başlamıyor.');
  if (stale) parts.push('Veriler 24 saatten eski.');
  parts.push('Kapsam eksiktir; bazı ilanlar yalnızca kurumların kendi sayfalarında yayımlanır.');

  function dismiss() {
    try {
      window.sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* özel mod: kapatma yalnızca bu görünüm için geçerli olur */
    }
    setDismissed(true);
  }

  return (
    <div className={`cloud-sync-banner is-${tone}`} role="status">
      <Icon name="info" size={15} />
      <span>{parts.join(' ')}</span>
      <button type="button" className="close-banner-btn" aria-label="Bilgilendirmeyi kapat" onClick={dismiss}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
