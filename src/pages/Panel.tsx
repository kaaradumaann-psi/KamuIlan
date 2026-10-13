/**
 * Kullanıcı paneli: bildirim tercihleri, geçmiş, hesap işlemleri.
 *
 * KVKK: kullanıcı kendi verisini görür, bildirimleri duraklatabilir, hesabını ve
 * kişisel verilerini silebilir. Başka kullanıcıya ait hiçbir veri gösterilmez.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/session';
import { EDUCATION_LEVELS, EDUCATION_LEVEL_LABELS } from '../domain/types';
import { EMPLOYMENT_TYPE_LABELS, formatDateTime, turkishCapitalize } from '../lib/format';
import type { NotificationHistoryResponse, PreferenceFilters, PreferencesResponse } from '../types';
import { Badge, Card, ErrorNotice, Field, InfoNote, Spinner } from '../components/ui';
import { ConfirmDialog } from '../components/ConfirmDialog';

const EMPTY_FILTERS: PreferenceFilters = {
  keywords: [],
  titles: [],
  institutions: [],
  cities: [],
  employmentTypes: [],
  educationLevels: [],
  departments: [],
  kpssScoreTypes: [],
  kpssMinScore: null,
  minDaysUntilDeadline: null,
};

function toList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 1);
}

export function PanelPage({ view = 'preferences' }: { view?: 'preferences' | 'history' } = {}): ReactNode {
  const queryClient = useQueryClient();
  const { logout } = useAuth();
  const preferences = useQuery({
    queryKey: ['preferences'],
    queryFn: () => api.get<PreferencesResponse>('/api/notifications/preferences'),
  });
  const history = useQuery({
    queryKey: ['history'],
    queryFn: () => api.get<NotificationHistoryResponse>('/api/notifications/history'),
  });
  const [filters, setFilters] = useState<PreferenceFilters>(EMPTY_FILTERS);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (preferences.data?.preference) {
      const current = preferences.data.preference.filters;
      setFilters({
        ...EMPTY_FILTERS,
        ...current,
        kpssMinScore: current.kpssMinScore ?? null,
        minDaysUntilDeadline: current.minDaysUntilDeadline ?? null,
      });
    }
  }, [preferences.data?.preference]);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.put<{ message: string }>('/api/notifications/preferences', body),
    onSuccess: (data) => {
      setMessage(data.message);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['preferences'] });
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const pause = useMutation({
    mutationFn: (paused: boolean) => api.post<{ message: string }>('/api/notifications/pause', { paused }),
    onSuccess: (data) => {
      setMessage(data.message);
      void queryClient.invalidateQueries({ queryKey: ['preferences'] });
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const testEmail = useMutation({
    mutationFn: () => api.post<{ message: string }>('/api/notifications/test-email'),
    onSuccess: (data) => {
      setMessage(data.message);
      void queryClient.invalidateQueries({ queryKey: ['history'] });
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const [deletePassword, setDeletePassword] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteAccount = useMutation({
    mutationFn: () =>
      api.post<{ message: string }>('/api/auth/delete-account', { confirm: 'SIL', password: deletePassword }),
    onSuccess: (data) => {
      setMessage(data.message);
      void queryClient.invalidateQueries();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  if (preferences.isLoading) return <Spinner label="Panel yükleniyor…" />;
  if (preferences.isError) {
    return (
      <Card title="Oturum gerekli">
        <ErrorNotice message={errorMessage(preferences.error)} />
        <p className="text-muted-sm push-lg">
          <Link to="/giris">Giriş yapın</Link>. Hesabınız yoksa yöneticiden davet isteyin — halka açık kayıt
          yoktur.
        </p>
      </Card>
    );
  }

  const data = preferences.data;
  if (!data) return null;
  const preference = data.preference;

  const submit = (): void => {
    save.mutate({
      enabled: true,
      paused: false,
      filters,
    });
  };

  return (
    <div className="page-stack">
      <header className="panel-head page-head">
        <div className="page-head-text">
          <span className="kicker">Kişisel çalışma alanı</span>
          <h1 className="panel-title">Panelim</h1>
          <p className="text-muted-sm">
            {data.email} için bildirim tercihleri · doğrulama:{' '}
            {data.emailVerified ? (
              <Badge tone="success">doğrulandı</Badge>
            ) : (
              <Badge tone="warning">doğrulanmadı</Badge>
            )}
          </p>
        </div>
        <div className="panel-head-actions">
          {preference && (
            <button type="button" className="btn-secondary" onClick={() => pause.mutate(!preference.paused)}>
              {preference.paused ? 'Bildirimleri sürdür' : 'Bildirimleri duraklat'}
            </button>
          )}
          <button
            type="button"
            className="btn-secondary"
            onClick={() => testEmail.mutate()}
            disabled={!data.emailVerified}
          >
            Test e-postası gönder
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              // Ortak çıkış akışı: sunucu oturumu kapatır, sorgu önbelleği
              // tazelenir ve giriş kapısı kullanıcıyı giriş ekranına alır.
              // (Hata sessizce yutulmaz: kullanıcıya gösterilir.)
              void logout()
                .then(() => {
                  setMessage('Oturum kapatıldı.');
                })
                .catch((caught: unknown) => {
                  setError(errorMessage(caught));
                });
            }}
          >
            Çıkış yap
          </button>
        </div>
      </header>

      <nav className="subnav-tabs" aria-label="Panel bölümleri">
        <Link className={view === 'preferences' ? 'subnav-tab is-active' : 'subnav-tab'} to="/panel">
          Tercihlerim
        </Link>
        <Link className={view === 'history' ? 'subnav-tab is-active' : 'subnav-tab'} to="/panel/gecmis">
          Bildirim geçmişi
        </Link>
        <Link className="subnav-tab" to="/panel/kaydedilenler">
          Kaydettiklerim
        </Link>
      </nav>

      {data.notice && <InfoNote tone="warning">{data.notice}</InfoNote>}
      {message && <InfoNote>{message}</InfoNote>}
      {error && <ErrorNotice message={error} />}

      {view === 'preferences' && (
        <Card
          title="Bildirim tercihleri"
          description="İlan, yazdığınız kelimelerden herhangi birine uyduğunda bildirim alırsınız. Boş bıraktığınız alan yok sayılır."
        >
          <form
            className="form-grid-2col"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <Field
              label="Anahtar kelimeler"
              htmlFor="pref-keywords"
              hint="Virgülle ayırın. İlan başlığı ve metninde aranır."
            >
              <input
                id="pref-keywords"
                className="input"
                value={draft['keywords'] ?? (preferences.data.preference?.filters.keywords ?? []).join(', ')}
                onChange={(event) => {
                  setDraft({ ...draft, keywords: event.target.value });
                  setFilters({ ...filters, keywords: toList(event.target.value) });
                }}
                placeholder="ör. hemşire, zabıta"
              />
            </Field>
            <Field label="Unvanlar" htmlFor="pref-titles" hint="Virgülle ayırın.">
              <input
                id="pref-titles"
                className="input"
                value={draft['titles'] ?? (preferences.data.preference?.filters.titles ?? []).join(', ')}
                onChange={(event) => {
                  setDraft({ ...draft, titles: event.target.value });
                  setFilters({ ...filters, titles: toList(event.target.value) });
                }}
                placeholder="ör. hemşire, mühendis"
              />
            </Field>
            <Field label="Kurumlar" htmlFor="pref-institutions" hint="Virgülle ayırın (kısmi eşleşme).">
              <input
                id="pref-institutions"
                className="input"
                value={
                  draft['institutions'] ??
                  (preferences.data.preference?.filters.institutions ?? []).join(', ')
                }
                onChange={(event) => {
                  setDraft({ ...draft, institutions: event.target.value });
                  setFilters({ ...filters, institutions: toList(event.target.value) });
                }}
              />
            </Field>
            <Field label="İller" htmlFor="pref-cities" hint="Virgülle ayırın.">
              <input
                id="pref-cities"
                className="input"
                value={draft['cities'] ?? (preferences.data.preference?.filters.cities ?? []).join(', ')}
                onChange={(event) => {
                  setDraft({ ...draft, cities: event.target.value });
                  setFilters({ ...filters, cities: toList(event.target.value) });
                }}
              />
            </Field>

            <fieldset className="form-col-span-2">
              <legend className="label">İstihdam türleri</legend>
              <div className="chip-row">
                {Object.entries(EMPLOYMENT_TYPE_LABELS).map(([value, label]) => (
                  <label key={value} className="chip">
                    <input
                      type="checkbox"

                      checked={filters.employmentTypes.includes(value as never)}
                      onChange={(event) =>
                        setFilters({
                          ...filters,
                          employmentTypes: event.target.checked
                            ? [...filters.employmentTypes, value as never]
                            : filters.employmentTypes.filter((item) => item !== value),
                        })
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="form-col-span-2">
              <legend className="label">Eğitim düzeyleri</legend>
              <div className="chip-row">
                {/* Yalnızca kanonik düzeyler: 'belirtilmemis' sunucuda geçersiz,
                    'lise' kayıtlarla eşleşmiyordu (kaydederken 400 hatası). */}
                {EDUCATION_LEVELS.map((level) => (
                  <label key={level} className="chip">
                    <input
                      type="checkbox"
                      checked={filters.educationLevels.includes(level)}
                      onChange={(event) =>
                        setFilters({
                          ...filters,
                          educationLevels: event.target.checked
                            ? [...filters.educationLevels, level]
                            : filters.educationLevels.filter((item) => item !== level),
                        })
                      }
                    />
                    {EDUCATION_LEVEL_LABELS[level]}
                  </label>
                ))}
              </div>
            </fieldset>

            <Field label="Bölümler" htmlFor="pref-departments" hint="Virgülle ayırın.">
              <input
                id="pref-departments"
                className="input"
                value={
                  draft['departments'] ?? (preferences.data.preference?.filters.departments ?? []).join(', ')
                }
                onChange={(event) => {
                  setDraft({ ...draft, departments: event.target.value });
                  setFilters({ ...filters, departments: toList(event.target.value) });
                }}
              />
            </Field>
            <Field label="KPSS asgari puan" htmlFor="pref-kpss-score">
              <input
                id="pref-kpss-score"
                className="input"
                type="number"
                min={0}
                max={100}
                value={filters.kpssMinScore ?? ''}
                onChange={(event) =>
                  setFilters({
                    ...filters,
                    kpssMinScore: event.target.value === '' ? null : Number(event.target.value),
                  })
                }
              />
            </Field>
            <Field
              label="Son başvuruya kalan en az gün"
              htmlFor="pref-days"
              hint="Çok yakın kapanan ilanları elemek için."
            >
              <input
                id="pref-days"
                className="input"
                type="number"
                min={0}
                max={365}
                value={filters.minDaysUntilDeadline ?? ''}
                onChange={(event) =>
                  setFilters({
                    ...filters,
                    minDaysUntilDeadline: event.target.value === '' ? null : Number(event.target.value),
                  })
                }
              />
            </Field>
            <Field label="Bildirim sıklığı" htmlFor="pref-mode">
              <select
                id="pref-mode"
                className="input"
                value={preference?.mode ?? 'instant'}
                onChange={(event) => save.mutate({ mode: event.target.value })}
              >
                <option value="instant">Anında (yeni ilan bulununca)</option>
                <option value="daily-digest">Günlük özet</option>
              </select>
            </Field>

            <div className="form-col-span-2 switch-list">
              <label className="switch-row">
                <input
                  type="checkbox"

                  checked={preference?.onlyNewJobs ?? true}
                  onChange={(event) => save.mutate({ onlyNewJobs: event.target.checked })}
                />
                Yalnızca yeni ilanlar için bildir (sonuç/atama duyuruları gönderilmez)
              </label>
              <label className="switch-row">
                <input
                  type="checkbox"

                  checked={preference?.notifyOnChanges ?? true}
                  onChange={(event) => save.mutate({ notifyOnChanges: event.target.checked })}
                />
                Takip ettiğim ilanda değişiklik olursa (tarih, kontenjan, koşul) bildir
              </label>
              <label className="switch-row">
                <input
                  type="checkbox"

                  checked={preference?.includeWorkerJobs ?? true}
                  onChange={(event) => save.mutate({ includeWorkerJobs: event.target.checked })}
                />
                Kamu işçisi (4/D) ilanlarını dahil et
              </label>
              <label className="switch-row">
                <input
                  type="checkbox"

                  checked={preference?.includeAcademicJobs ?? true}
                  onChange={(event) => save.mutate({ includeAcademicJobs: event.target.checked })}
                />
                Akademik kadro ilanlarını dahil et
              </label>
            </div>

            <div className="form-col-span-2">
              <button type="submit" className="btn-primary" disabled={save.isPending}>
                {save.isPending ? 'Kaydediliyor…' : 'Tercihleri kaydet ve bildirimleri aç'}
              </button>
            </div>
          </form>
        </Card>
      )}

      {view === 'history' && (
        <Card title="Bildirim geçmişi" description="Gönderilen e-postalar ve eşleşme nedenleri.">
          {history.isLoading && <Spinner />}
          {history.isError && (
            <ErrorNotice message={errorMessage(history.error)} onRetry={() => void history.refetch()} />
          )}
          {history.data && (
            <>
              {history.data.events.length === 0 ? (
                <p className="text-muted-sm">Henüz bildirim üretilmedi.</p>
              ) : (
                <ul className="event-list">
                  {history.data.events.map((event) => (
                    <li key={event.id} className="event-card">
                      <p className="event-title">{event.jobTitle ?? event.jobId}</p>
                      <p className="text-muted-sm">
                        {event.kind === 'new-job' ? 'Yeni ilan' : 'İlan güncellendi'} ·{' '}
                        {formatDateTime(event.createdAt)} ·{' '}
                        {event.matchedOn.length > 0
                          ? `eşleşme: ${event.matchedOn.join(', ')}`
                          : 'eşleşme bilgisi yok'}
                      </p>
                      {event.status === 'suppressed' && (
                        <p className="event-note">Gönderilmedi: {event.suppressionReason ?? 'engellendi'}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {history.data.emails.length > 0 && (
                <div className="push-xl">
                  <h3 className="section-heading-sm">E-posta durumları</h3>
                  <ul className="email-list push">
                    {history.data.emails.map((email) => (
                      <li key={email.id} className="email-row">
                        <Badge
                          tone={
                            email.status === 'accepted'
                              ? 'success'
                              : email.status === 'dead'
                                ? 'danger'
                                : 'neutral'
                          }
                        >
                          {email.statusLabel}
                        </Badge>
                        <span>{email.subject}</span>
                        <span className="email-meta">{formatDateTime(email.createdAt)}</span>
                        {email.attempts > 1 && <span className="email-meta">{email.attempts} deneme</span>}
                      </li>
                    ))}
                  </ul>
                  <p className="text-muted-sm push">{history.data.notice}</p>
                </div>
              )}
            </>
          )}
        </Card>
      )}

      {view === 'preferences' && (
        <Card title="Hesap ve veriler" description="Bilgileriniz sizin elinizde.">
          <p className="body-copy">
            Bildirimleri duraklatmak ya da hesabınızı silmek için aşağıdaki işlemleri kullanabilirsiniz. Hesap
            silindiğinde e-posta adresiniz tanınmaz hale getirilir; toplanan ilan bilgileri (herkese açık
            kayıtlar) korunur.
          </p>
          <div className="danger-zone">
            <Field
              label="Hesabı silmek için parolanızı girin"
              htmlFor="delete-password"
              hint="Bu işlem geri alınamaz."
            >
              <input
                id="delete-password"
                className="input"
                type="password"
                autoComplete="current-password"
                value={deletePassword}
                onChange={(event) => setDeletePassword(event.target.value)}
              />
            </Field>
            <button
              type="button"
              className="btn-danger"
              disabled={deletePassword.length < 10 || deleteAccount.isPending}
              onClick={() => setConfirmDelete(true)}
            >
              Hesabımı sil
            </button>
            {confirmDelete && (
              <ConfirmDialog
                title="Hesabı sil"
                description="Bu işlem geri alınamaz: e-posta adresiniz anonimleştirilir, bildirim tercihleriniz ve oturumlarınız kaldırılır. Kamuya açık ilan kayıtları korunur."
                confirmLabel="Hesabımı kalıcı olarak sil"
                busy={deleteAccount.isPending}
                onConfirm={() => deleteAccount.mutate()}
                onCancel={() => setConfirmDelete(false)}
              />
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

/** Tercihler sayfası için küçük yardımcı: başlıkları Türkçe biçimde gösterir. */
export function readableTitle(value: string): string {
  return turkishCapitalize(value);
}
