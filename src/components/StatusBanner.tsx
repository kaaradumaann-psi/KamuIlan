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
import { HEALTH_QUERY_KEY } from '../lib/query-keys';
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
    queryKey: HEALTH_QUERY_KEY,
    queryFn: ({ signal }) => api.get<HealthResponse>('/api/health', undefined, signal),
    refetchInterval: 60_000,
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
      ? `İlanlar en son ${formatRelative(data.scans.lastSuccessAt)} başarıyla tarandı.`
      : 'Henüz başarılı tarama kaydı yok.',
  );
  parts.push(`${formatNumber(data.sources.enabled)} kaynak tarama için etkin olarak tanımlı.`);
  if (failing) parts.push(`${formatNumber(data.sources.failing)} kaynağa şu an ulaşılamıyor.`);
  if (noWorker) {
    parts.push('Tarama worker’ı şu an çalışmıyor; zamanlanmış taramalar yürütülmüyor.');
  } else if (!data.scans.lastSuccessAt) {
    parts.push('İlk başarılı taramanın tamamlanması bekleniyor.');
  }
  if (data.sources.stale > 0) parts.push(`${formatNumber(data.sources.stale)} etkin kaynakta yakın zamanda başarılı tarama yok.`);
  if (stale) parts.push('Son başarılı tarama bir günden eski olabilir.');
  parts.push('Bazı kurumlar ilanını yalnızca kendi sayfasında duyurur; her ilanı bulamayabiliriz.');

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
