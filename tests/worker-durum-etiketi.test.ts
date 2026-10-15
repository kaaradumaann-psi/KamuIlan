/**
 * Panel worker durum etiketi ve satır kırpma (2026-10-16 canlı döküm bulgusu).
 *
 * Dökümde 17 worker satırından yalnızca biri "bayat" görünüyordu; 42–47 saat
 * önce durmuş süreçler yeşil "çalışıyor" rozeti taşıyordu. Kök neden: rozet
 * yalnızca `stale` alanına bakıyordu, `status` alanına bakmıyordu.
 */
import { describe, expect, it } from 'vitest';

import { describeWorkerState, sortWorkersByRecency } from '../src/lib/format';

describe('describeWorkerState', () => {
  it('canlı süreç yeşil "çalışıyor" olur', () => {
    expect(describeWorkerState('running', false)).toEqual({ tone: 'success', label: 'çalışıyor' });
  });

  it('bilinçli kapanan süreç "durdu" olur — "çalışıyor" DEĞİL', () => {
    expect(describeWorkerState('stopped', false)).toEqual({ tone: 'neutral', label: 'durdu' });
    expect(describeWorkerState('stopping', false)).toEqual({ tone: 'warning', label: 'duruyor' });
    expect(describeWorkerState('starting', false)).toEqual({ tone: 'info', label: 'başlıyor' });
  });

  it('sessiz kalan süreç (durduğunu bildirmedi) kırmızı "bayat" olur', () => {
    expect(describeWorkerState('running', true)).toEqual({ tone: 'danger', label: 'bayat' });
    expect(describeWorkerState('stopped', true)).toEqual({ tone: 'danger', label: 'bayat' });
  });

  it('beklenmedik ya da eksik durum uydurulmaz, açıkça yazılır', () => {
    expect(describeWorkerState('crashed', false).label).toContain('crashed');
    expect(describeWorkerState(undefined, false).label).toBe('durum bilinmiyor');
  });
});

describe('sortWorkersByRecency', () => {
  const rows = [
    { workerId: 'eski', lastHeartbeatAt: '2026-10-12T10:00:00.000Z' },
    { workerId: 'yeni', lastHeartbeatAt: '2026-10-16T10:00:00.000Z' },
    { workerId: 'orta', lastHeartbeatAt: '2026-10-14T10:00:00.000Z' },
  ];

  it('en yeni kalp atışı üstte olur', () => {
    expect(sortWorkersByRecency(rows).visible.map((row) => row.workerId)).toEqual(['yeni', 'orta', 'eski']);
  });

  it('uzun listeler kırpılır ve gizli satır sayısı raporlanır', () => {
    const many = Array.from({ length: 17 }, (_, index) => ({
      workerId: `w-${index}`,
      lastHeartbeatAt: new Date(Date.UTC(2026, 9, 1) + index * 3_600_000).toISOString(),
    }));
    const { visible, hidden } = sortWorkersByRecency(many, 6);
    expect(visible).toHaveLength(6);
    expect(hidden).toBe(11);
    expect(visible[0]?.workerId).toBe('w-16');
  });

  it('boş liste ve limit=0 güvenle ele alınır', () => {
    expect(sortWorkersByRecency([])).toEqual({ visible: [], hidden: 0 });
    expect(sortWorkersByRecency(rows, 0).visible).toHaveLength(1);
  });
});
