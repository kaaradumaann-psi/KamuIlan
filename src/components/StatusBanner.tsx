/**
 * Durum şeridi (üst bilgi altı).
 *
 * Normal durumda HİÇ görünmez: her sayfada tekrar eden bilgi bandı kullanıcıya
 * yük olur. Yalnızca kullanıcının gördüğü listeyi etkileyen iki durumda kısa,
 * teknik olmayan bir cümle gösterilir:
 *  - sistem erişilemez (`down`),
 *  - son başarılı güncelleme bir günden eski.
 * Tarama süreçleri, kaynak sayıları gibi ayrıntılar yönetim panelindedir.
 *
 * Şerit kapatılabilir: kapatma yalnızca oturum belleğinde tutulur.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { HEALTH_QUERY_KEY } from '../lib/query-keys';
import { formatRelative } from '../lib/format';
import type { HealthResponse } from '../types';
import { Icon } from './Icon';

const DISMISS_KEY = 'kamuilan:status-banner-dismissed';
const STALE_MINUTES = 24 * 60;

function readDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

/** Gösterilecek tek cümle; normal durumda `null`. */
export function statusBannerMessage(data: HealthResponse): string | null {
  if (data.status === 'down') {
    return 'Şu anda ilan listesine ulaşmakta sorun yaşıyoruz. Lütfen biraz sonra yeniden deneyin.';
  }
  const minutes = data.scans.minutesSinceSuccess;
  if (data.scans.lastSuccessAt && minutes !== null && minutes > STALE_MINUTES) {
    return `İlanlar en son ${formatRelative(data.scans.lastSuccessAt)} güncellendi; yeni ilanlar gecikebilir.`;
  }
  return null;
}

export function StatusBanner() {
  const [dismissed, setDismissed] = useState(readDismissed);
  const health = useQuery({
    queryKey: HEALTH_QUERY_KEY,
    queryFn: ({ signal }) => api.get<HealthResponse>('/api/health', undefined, signal),
    refetchInterval: 60_000,
  });

  if (dismissed || !health.data) return null;
  const message = statusBannerMessage(health.data);
  if (!message) return null;

  function dismiss() {
    try {
      window.sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* özel mod: kapatma yalnızca bu görünüm için geçerli olur */
    }
    setDismissed(true);
  }

  return (
    <div className="cloud-sync-banner is-warning" role="status">
      <Icon name="info" size={15} />
      <span>{message}</span>
      <button type="button" className="close-banner-btn" aria-label="Bilgilendirmeyi kapat" onClick={dismiss}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
