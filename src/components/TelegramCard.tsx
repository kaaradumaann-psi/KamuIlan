/**
 * Panel: Telegram bildirim kartı.
 *
 * Tek durum kaynağı sunucudur (`/api/telegram/status`). Kart, kullanıcının bağlantı
 * durumuna göre tek bir sonraki adımı gösterir:
 *   bağlı değil → "Telegram'a bağla" (kod + bağlantı) → bağlanana kadar otomatik kontrol
 *   açık        → test / duraklat / kaldır
 *   duraklatıldı→ sürdür / kaldır
 *   engellendi  → botu yeniden başlatma yönergesi / yeniden bağlan / kaldır
 * Telegram yapılandırılmamışsa kart gösterilmez (kullanıcıya işe yaramayan düğme sunulmaz).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api, errorMessage } from '../lib/api';
import { formatDateTime } from '../lib/format';
import type { TelegramLinkCodeResponse, TelegramStatusResponse } from '../types';
import { Badge, Card, ErrorNotice, InfoNote, Spinner } from './ui';
import { ConfirmDialog } from './ConfirmDialog';

const STATUS_QUERY_KEY = ['telegram-status'] as const;

export function TelegramCard(): ReactNode {
  const queryClient = useQueryClient();
  const [linkCode, setLinkCode] = useState<TelegramLinkCodeResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [copied, setCopied] = useState(false);

  const status = useQuery({
    queryKey: STATUS_QUERY_KEY,
    queryFn: ({ signal }) => api.get<TelegramStatusResponse>('/api/telegram/status', undefined, signal),
    // Bağlantı kodu üretildiyse kullanıcı Telegram'da onaylayana kadar kendiliğinden kontrol et.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!linkCode) return false;
      return data?.link?.status === 'active' ? false : 4_000;
    },
  });

  const refresh = (): Promise<unknown> => queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });

  const createCode = useMutation({
    mutationFn: () => api.post<TelegramLinkCodeResponse>('/api/telegram/link-code'),
    onSuccess: (data) => {
      setLinkCode(data);
      setCopied(false);
      setError(null);
      setMessage(data.message);
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const test = useMutation({
    mutationFn: () => api.post<{ message: string }>('/api/telegram/test'),
    onSuccess: (data) => {
      setMessage(data.message);
      setError(null);
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const pause = useMutation({
    mutationFn: (paused: boolean) => api.post<{ message: string }>('/api/telegram/pause', { paused }),
    onSuccess: (data) => {
      setMessage(data.message);
      setError(null);
      void refresh();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const unlink = useMutation({
    mutationFn: () => api.del<{ message: string }>('/api/telegram/link'),
    onSuccess: (data) => {
      setMessage(data.message);
      setError(null);
      setLinkCode(null);
      setConfirmUnlink(false);
      void refresh();
    },
    onError: (caught) => {
      setError(errorMessage(caught));
      setConfirmUnlink(false);
    },
  });

  if (status.isLoading) {
    return (
      <Card title="Telegram bildirimleri">
        <Spinner label="Telegram durumu yükleniyor…" />
      </Card>
    );
  }
  if (status.isError) {
    return (
      <Card title="Telegram bildirimleri">
        <ErrorNotice message={errorMessage(status.error)} />
      </Card>
    );
  }
  const data = status.data;
  if (!data || !data.configured) return null;

  const link = data.link;
  const linkStatus = link?.status ?? null;
  const busy = createCode.isPending || test.isPending || pause.isPending || unlink.isPending;

  const copyCommand = (): void => {
    if (!linkCode) return;
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clipboard) {
      setError('Tarayıcınız kopyalamayı desteklemiyor. Komutu elle seçip kopyalayın.');
      return;
    }
    void clipboard.writeText(linkCode.manualCommand).then(
      () => setCopied(true),
      () => setError('Kopyalanamadı. Komutu elle seçip kopyalayın.'),
    );
  };

  const toneBadge =
    linkStatus === 'active' ? (
      <Badge tone="success">bağlı ve açık</Badge>
    ) : linkStatus === 'stopped' ? (
      <Badge tone="warning">duraklatıldı</Badge>
    ) : linkStatus === 'blocked' ? (
      <Badge tone="danger">bot engellenmiş</Badge>
    ) : (
      <Badge tone="neutral">bağlı değil</Badge>
    );

  return (
    <Card
      title="Telegram bildirimleri"
      description="Eşleşen yeni ilan ve değişikliklerin bir kopyası Telegram’a da gelir. E-posta ayarlarınız aynen geçerlidir."
      actions={toneBadge}
    >
      {message && <InfoNote tone="success">{message}</InfoNote>}
      {error && <ErrorNotice message={error} />}
      {data.notice && linkStatus !== 'active' && <InfoNote tone="info">{data.notice}</InfoNote>}
      {linkStatus === 'active' && !data.notificationsOn && (
        <InfoNote tone="warning">
          Telegram bağlı, ancak bildirim tercihleriniz kapalı. Eşleşen ilanların gelmesi için “Bildirim
          tercihleri” bölümünden tercihlerinizi kaydedin.
        </InfoNote>
      )}

      {(linkStatus === null || linkStatus === 'blocked') && (
        <div className="stack-sm">
          {linkStatus === 'blocked' && (
            <p className="text-muted-sm">
              Telegram’da Kamuİlan botunu açıp <strong>/basla</strong> yazarsanız bildirimler yeniden açılır
              ya da aşağıdan yeni bir bağlantı başlatabilirsiniz.
            </p>
          )}
          {!linkCode && (
            <p className="text-muted-sm">
              Bağlandıktan sonra bildirimler Telegram’da gelir. Bağlantıyı istediğiniz zaman
              kaldırabilirsiniz.
            </p>
          )}
          {linkCode ? (
            <div className="stack-sm" aria-live="polite">
              <p>
                <strong>1.</strong> Telegram’da botu açın:{' '}
                <a className="btn-primary" href={linkCode.deepLink} target="_blank" rel="noopener noreferrer">
                  Telegram’da aç
                </a>
              </p>
              <p className="text-muted-sm">
                <strong>2.</strong> Açılan ekranda <em>Başlat</em> düğmesine basın. Telegram açılmazsa botu (@
                {linkCode.botUsername}) elle açıp şu komutu gönderin:
              </p>
              <div className="inline-row">
                <code className="code-block" data-testid="telegram-link-command">
                  {linkCode.manualCommand}
                </code>
                <button type="button" className="btn-secondary" onClick={copyCommand}>
                  {copied ? 'Kopyalandı' : 'Komutu kopyala'}
                </button>
              </div>
              <p className="text-muted-sm">
                Kod {formatDateTime(linkCode.expiresAt)} tarihine kadar geçerlidir. Bağlantı kurulunca bu
                ekran otomatik güncellenir.
              </p>
              <div className="inline-row">
                <button type="button" className="btn-ghost" onClick={() => void refresh()}>
                  Şimdi kontrol et
                </button>
                <button type="button" className="btn-ghost" onClick={() => setLinkCode(null)}>
                  Vazgeç
                </button>
              </div>
            </div>
          ) : (
            <div className="inline-row">
              <button
                type="button"
                className="btn-primary"
                disabled={busy}
                onClick={() => createCode.mutate()}
              >
                {createCode.isPending
                  ? 'Hazırlanıyor…'
                  : linkStatus === 'blocked'
                    ? 'Yeni bağlantı başlat'
                    : 'Telegram’a bağla'}
              </button>
            </div>
          )}
        </div>
      )}

      {linkStatus === 'active' && (
        <div className="stack-sm">
          <p className="text-muted-sm">
            {link?.telegramUsername ? `Telegram hesabı: @${link.telegramUsername} · ` : ''}Bağlandı:{' '}
            {formatDateTime(link?.linkedAt)}
          </p>
          <div className="inline-row">
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => test.mutate()}>
              {test.isPending ? 'Gönderiliyor…' : 'Test mesajı gönder'}
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => pause.mutate(true)}
            >
              Telegram bildirimlerini duraklat
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={busy}
              onClick={() => setConfirmUnlink(true)}
            >
              Bağlantıyı kaldır
            </button>
          </div>
        </div>
      )}

      {linkStatus === 'stopped' && (
        <div className="stack-sm">
          <p className="text-muted-sm">
            Telegram bildirimleri duraklatıldı. Yeniden açana kadar Telegram’a mesaj gönderilmez. E-posta
            bildirimleri etkilenmez.
          </p>
          <div className="inline-row">
            <button type="button" className="btn-primary" disabled={busy} onClick={() => pause.mutate(false)}>
              Telegram bildirimlerini sürdür
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={busy}
              onClick={() => setConfirmUnlink(true)}
            >
              Bağlantıyı kaldır
            </button>
          </div>
        </div>
      )}

      {confirmUnlink && (
        <ConfirmDialog
          title="Telegram bağlantısı kaldırılsın mı?"
          description="Bekleyen Telegram bildirimleri iptal edilir. Yeniden bağlamak için yeni bir bağlantı başlatmanız gerekir."
          confirmLabel="Bağlantıyı kaldır"
          busy={unlink.isPending}
          onConfirm={() => unlink.mutate()}
          onCancel={() => setConfirmUnlink(false)}
        />
      )}
    </Card>
  );
}
