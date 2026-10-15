/**
 * Panel: "Bana uygun ilanlar" (yapay zekâ destekli, açık rıza ile).
 *
 * Akış: rıza ekranı (ne gönderildiği açıkça yazılı) → profil uyarısı (gerekiyorsa)
 * → öneri isteği → sonuç listesi. Kart yalnızca operatör etkinleştirdiyse görünür.
 * Sonuçlar "ön eleme"dir: kesin uygunluk resmî ilan şartlarıyla belirlenir.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { formatDateOnly } from '../lib/format';
import type { AiStatusResponse, AiSuggestionsResponse } from '../types';
import { Badge, Card, ErrorNotice, InfoNote, Spinner } from './ui';

const STATUS_KEY = ['ai-status'] as const;

const FIT_LABEL: Record<
  'strong' | 'possible' | 'weak',
  { label: string; tone: 'success' | 'info' | 'neutral' }
> = {
  strong: { label: 'Güçlü uyum', tone: 'success' },
  possible: { label: 'Olası uyum', tone: 'info' },
  weak: { label: 'Zayıf uyum', tone: 'neutral' },
};

export function AiSuggestionsCard(): ReactNode {
  const queryClient = useQueryClient();
  const [consentChecked, setConsentChecked] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AiSuggestionsResponse | null>(null);

  const status = useQuery({
    queryKey: STATUS_KEY,
    queryFn: ({ signal }) => api.get<AiStatusResponse>('/api/ai/status', undefined, signal),
  });

  const consent = useMutation({
    mutationFn: (granted: boolean) => api.put<{ message: string }>('/api/ai/consent', { granted }),
    onSuccess: (data) => {
      setMessage(data.message);
      setError(null);
      setResult(null);
      setConsentChecked(false);
      void queryClient.invalidateQueries({ queryKey: STATUS_KEY });
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const suggest = useMutation({
    mutationFn: () => api.post<AiSuggestionsResponse>('/api/ai/suggestions'),
    onSuccess: (data) => {
      setResult(data);
      setError(null);
      setMessage(null);
      void queryClient.invalidateQueries({ queryKey: STATUS_KEY });
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  if (status.isLoading) {
    return (
      <Card title="Bana uygun ilanlar">
        <Spinner label="Öneri durumu yükleniyor…" />
      </Card>
    );
  }
  if (status.isError) {
    return (
      <Card title="Bana uygun ilanlar">
        <ErrorNotice message={errorMessage(status.error)} />
      </Card>
    );
  }
  const data = status.data;
  if (!data || !data.enabled) return null;

  const badge = data.consent.given ? (
    <Badge tone="success">rıza verildi</Badge>
  ) : (
    <Badge tone="neutral">rıza gerekli</Badge>
  );

  return (
    <Card
      title="Bana uygun ilanlar"
      description="Profilinizi ve açık ilanları karşılaştırarak başvurmaya değer olabilecek ilanları önerir. Yapay zekâ destekli bir ön elemedir."
      actions={badge}
    >
      {message && <InfoNote tone="success">{message}</InfoNote>}
      {error && <ErrorNotice message={error} />}

      {!data.consent.given && (
        <div className="stack-sm">
          <InfoNote tone="info">
            <strong>Ne gönderilir?</strong> Meslek/unvanınız, eğitim düzeyiniz, bölüm, becerileriniz ve
            deneyim yılınız; ayrıca eşleşmeye aday en fazla 12 açık ilanın başlığı, kurumu, şehri, çalışma
            biçimi, son başvuru tarihi, kontenjanı ve eğitim/bölüm/KPSS koşulları. Ad, e-posta, TC kimlik
            numarası ve parolanız <strong>gönderilmez</strong>.
          </InfoNote>
          <p className="text-muted-sm">
            <strong>Kime gönderilir?</strong> {data.providerLabel}. İstek başına yalnızca yukarıdaki bilgiler
            iletilir; hizmet sağlayıcının sakladığı veriler için onun politikası geçerlidir. Rızanızı
            istediğiniz zaman geri çekebilirsiniz; geri çekildiğinde profiliniz artık gönderilmez.
          </p>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={consentChecked}
              onChange={(event) => setConsentChecked(event.target.checked)}
            />{' '}
            Yukarıdaki bilgilerin yapay zekâ hizmetine gönderilmesine açıkça izin veriyorum.
          </label>
          <div className="inline-row">
            <button
              type="button"
              className="btn-primary"
              disabled={!consentChecked || consent.isPending}
              onClick={() => consent.mutate(true)}
            >
              {consent.isPending ? 'Kaydediliyor…' : 'Rıza ver ve önerileri aç'}
            </button>
          </div>
        </div>
      )}

      {data.consent.given && (
        <div className="stack-sm">
          {!data.profileReady ? (
            <InfoNote tone="warning">
              Öneri üretmek için önce yukarıdaki profil bölümünde meslek/unvan, eğitim düzeyi veya
              becerilerinizi doldurup kaydedin.
            </InfoNote>
          ) : (
            <div className="inline-row">
              <button
                type="button"
                className="btn-primary"
                disabled={suggest.isPending || data.remainingToday <= 0}
                onClick={() => suggest.mutate()}
              >
                {suggest.isPending
                  ? 'Öneriler hazırlanıyor…'
                  : result
                    ? 'Önerileri yenile'
                    : 'Bana uygun ilanları öner'}
              </button>
              <span className="text-muted-sm">
                {data.remainingToday > 0
                  ? `Bugün kalan öneri hakkı: ${data.remainingToday} / ${data.dailyLimit}`
                  : result
                    ? 'Bugünlük öneri hakkınız doldu; yarın yeniden deneyebilirsiniz. Son öneriniz aşağıda duruyor.'
                    : 'Bugünlük öneri hakkınız doldu; yarın yeniden deneyebilirsiniz.'}
              </span>
            </div>
          )}
          <div className="inline-row">
            <button
              type="button"
              className="btn-ghost"
              disabled={consent.isPending}
              onClick={() => consent.mutate(false)}
            >
              Rızayı geri çek
            </button>
          </div>
        </div>
      )}

      {result && <SuggestionList result={result} />}
    </Card>
  );
}

function SuggestionList({ result }: { result: AiSuggestionsResponse }): ReactNode {
  return (
    <div className="stack-sm" aria-live="polite">
      <div className="inline-row">
        <Badge tone={result.mode === 'ai' ? 'accent' : 'neutral'}>
          {result.mode === 'ai'
            ? 'Yapay zekâ önerisi'
            : result.mode === 'profile-fallback'
              ? 'Profil eşleştirmesi'
              : 'Sonuç yok'}
        </Badge>
        {result.cached && (
          <span className="text-muted-sm">Son öneriniz gösteriliyor (20 dakika önbellek).</span>
        )}
      </div>
      {result.notice && <InfoNote tone="warning">{result.notice}</InfoNote>}

      {result.suggestions.length === 0 && result.mode !== 'none' && (
        <p className="text-muted-sm">Bu profil için belirgin bir öneri çıkmadı.</p>
      )}

      <ol className="ai-suggestion-list">
        {result.suggestions.map((item) => (
          <li key={item.jobId} className="ai-suggestion-item">
            <div className="inline-row">
              <Badge tone={FIT_LABEL[item.fit].tone}>{FIT_LABEL[item.fit].label}</Badge>
              <Link to={`/ilanlar/${encodeURIComponent(item.jobId)}`}>
                <strong>{item.title}</strong>
              </Link>
            </div>
            <p className="text-muted-sm">
              {item.institution}
              {item.city ? ` · ${item.city}` : ''} · {item.employmentTypeLabel} · Son başvuru:{' '}
              {formatDateOnly(item.applicationEndDate)}
            </p>
            {item.reasons.length > 0 && (
              <ul className="profile-match-list">
                {item.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
            {item.caveats.length > 0 && (
              <ul className="profile-match-list profile-match-caveats">
                {item.caveats.map((caveat) => (
                  <li key={caveat}>{caveat}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>

      <p className="text-muted-sm">
        Bu öneriler kesin uygunluk kararı değildir. Başvuru şartlarını ve tarihlerini resmî ilan metninden
        kontrol edin.
      </p>
    </div>
  );
}
