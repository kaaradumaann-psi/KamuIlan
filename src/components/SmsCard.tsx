/**
 * Panel: SMS bildirim kartı (Twilio).
 *
 * SMS yalnız takip edilen ilan değişikliği ve son başvuru hatırlatmasında kullanılır. Numara ve
 * AÇIK RIZA olmadan gönderim yapılmaz; rıza kaldırılınca bekleyen SMS'ler bastırılır.
 * Sunucuda SMS yapılandırılmamışsa kart gösterilmez.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { api, errorMessage } from '../lib/api';
import { Card, ErrorNotice, InfoNote } from './ui';

interface SmsState {
  enabled: boolean;
  phoneE164: string | null;
  consentAt: string | null;
}

const QUERY_KEY = ['notifications-sms'] as const;

export function SmsCard(): ReactNode {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: QUERY_KEY,
    queryFn: ({ signal }) =>
      api.get<{ available: boolean; sms: SmsState }>('/api/notifications/sms', undefined, signal),
  });
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!status.data) return;
    setPhone(status.data.sms.phoneE164 ?? '');
    setConsent(Boolean(status.data.sms.consentAt));
  }, [status.data]);

  const save = useMutation({
    mutationFn: (enabled: boolean) =>
      api.put<{ sms: SmsState; message: string }>('/api/notifications/sms', {
        phone: phone.trim() || null,
        consent,
        enabled,
      }),
    onSuccess: (data) => {
      setMessage(data.message);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (caught) => {
      setError(errorMessage(caught));
      setMessage(null);
    },
  });

  if (!status.data?.available) return null;
  const enabled = status.data.sms.enabled;

  return (
    <Card
      title="SMS bildirimleri"
      description="Takip ettiğiniz ilan değişince ve son başvuru yaklaşınca kısa mesaj alırsınız."
    >
      <div className="stack-sm">
        <label className="field">
          <span>Cep telefonu</span>
          <input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="0532 123 45 67"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
          <span>Bu numaraya ilan bildirimi SMS'i gönderilmesine açık rıza veriyorum.</span>
        </label>
        <div className="inline-row">
          <button
            type="button"
            className="btn-primary btn-sm"
            disabled={save.isPending || !consent || !phone.trim()}
            onClick={() => save.mutate(true)}
          >
            {enabled ? 'Kaydet' : 'SMS’i aç'}
          </button>
          {enabled && (
            <button type="button" className="btn-secondary btn-sm" disabled={save.isPending} onClick={() => save.mutate(false)}>
              SMS’i kapat
            </button>
          )}
        </div>
        {message && <InfoNote>{message}</InfoNote>}
        {error && <ErrorNotice message={error} />}
      </div>
    </Card>
  );
}
