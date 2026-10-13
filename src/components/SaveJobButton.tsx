/**
 * Kaydet düğmesi — adayın takip listesi.
 *
 * Oturum yoksa düğme girişe yönlendirir (kayıt davetle açılır, politika
 * değişmez). Oturum varsa durum sunucudan okunur (`/api/me/saved-jobs`);
 * tarayıcıda sahte/yerel bir liste tutulmaz.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/session';
import type { SavedJobsResponse } from '../types';
import { Icon } from './Icon';

export function SaveJobButton({ jobId, compact = false }: { jobId: string; compact?: boolean }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const saved = useQuery({
    queryKey: ['saved-jobs'],
    queryFn: () => api.get<SavedJobsResponse>('/api/me/saved-jobs'),
    enabled: Boolean(user),
    staleTime: 30_000,
  });
  const isSaved = Boolean(user) && (saved.data?.items ?? []).some((item) => item.job.id === jobId);

  // Hata sessizce yutulmaz: kaydetme başarısızsa kullanıcı nedenini görür
  // (aksi hâlde düğme eski hâline döner ve "kaydettim mi?" belirsizliği kalırdı).
  const [problem, setProblem] = useState<string | null>(null);
  const toggle = useMutation({
    mutationFn: () =>
      api.post<{ saved: boolean; message: string }>(`/api/jobs/${encodeURIComponent(jobId)}/save`),
    onSuccess: () => {
      setProblem(null);
      void queryClient.invalidateQueries({ queryKey: ['saved-jobs'] });
    },
    onError: (error: unknown) => setProblem(errorMessage(error)),
  });

  if (!user) {
    return (
      <button
        type="button"
        className={compact ? 'btn-secondary btn-sm' : 'btn-secondary'}
        onClick={() => navigate('/giris')}
        title="Kaydetmek için giriş yapın (hesap yönetici davetiyle açılır)"
      >
        <Icon name="save" size={15} />
        <span>Kaydet</span>
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        className={`${compact ? 'btn-secondary btn-sm' : 'btn-secondary'} save-toggle${isSaved ? ' is-saved' : ''}`}
        aria-pressed={isSaved}
        disabled={toggle.isPending || saved.isLoading}
        onClick={() => toggle.mutate()}
      >
        <Icon name={isSaved ? 'check' : 'save'} size={15} />
        <span>{toggle.isPending ? 'Kaydediliyor…' : isSaved ? 'Kaydedildi' : 'Kaydet'}</span>
      </button>
      {problem ? (
        <span className="text-muted-sm" role="alert" aria-live="polite">
          Kaydedilemedi: {problem}
        </span>
      ) : null}
    </>
  );
}
