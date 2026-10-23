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
import type {
  CandidateProfile,
  NotificationHistoryResponse,
  PreferenceFilters,
  PreferencesResponse,
} from '../types';
import { Badge, Card, ErrorNotice, Field, InfoNote, Spinner } from '../components/ui';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { TelegramCard } from '../components/TelegramCard';
import { AiSuggestionsCard } from '../components/AiSuggestionsCard';

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

const EMPTY_PROFILE: CandidateProfile = {
  profession: '',
  educationLevel: null,
  departments: [],
  skills: [],
  experienceYears: null,
};

interface NotificationSettings {
  onlyNewJobs: boolean;
  notifyOnChanges: boolean;
  includeWorkerJobs: boolean;
  includeAcademicJobs: boolean;
}

const DEFAULT_SETTINGS: NotificationSettings = {
  onlyNewJobs: true,
  notifyOnChanges: true,
  includeWorkerJobs: true,
  includeAcademicJobs: true,
};

function toList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 1);
}

/**
 * Kaydet düğmesinin yanındaki sonuç satırı. Sayfa başındaki bildirim, form
 * aşağı kaydırılmışken görünmüyordu; kullanıcı kaydın olmadığını sanıyordu.
 */
function SaveFeedback({
  message,
  error,
  pending,
}: {
  message: string | null;
  error: string | null;
  pending: boolean;
}): ReactNode {
  if (pending) return null;
  if (error) {
    return (
      <p className="form-error push-sm" role="alert">
        Kaydedilemedi: {error}
      </p>
    );
  }
  if (!message) return null;
  return (
    <p className="text-muted-sm push-sm" role="status">
      ✓ {message}
    </p>
  );
}

export function PanelPage({ view = 'preferences' }: { view?: 'preferences' | 'history' } = {}): ReactNode {
  const queryClient = useQueryClient();
  const { logout } = useAuth();
  const preferences = useQuery({
    queryKey: ['preferences'],
    queryFn: ({ signal }) => api.get<PreferencesResponse>('/api/notifications/preferences', undefined, signal),
  });
  const history = useQuery({
    queryKey: ['history'],
    queryFn: ({ signal }) => api.get<NotificationHistoryResponse>('/api/notifications/history', undefined, signal),
  });
  const [filters, setFilters] = useState<PreferenceFilters>(EMPTY_FILTERS);
  const [candidateProfile, setCandidateProfile] = useState<CandidateProfile>(EMPTY_PROFILE);
  const [profilePersonalizationEnabled, setProfilePersonalizationEnabled] = useState(false);
  // Bildirim anahtarları da formun parçasıdır: eskiden tıklanınca tek başına
  // kaydediliyordu, metin alanları ise düğme bekliyordu (karışık davranış).
  const [settings, setSettings] = useState<NotificationSettings>(DEFAULT_SETTINGS);
  // "Ek koşullar" yalnızca kayıtlı bir koşul varsa açık başlar; sonra kullanıcıya kalır.
  const [moreOpen, setMoreOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  // Virgüllü profil alanlarının ham metni: diziye çevrilip geri yazılırsa ilk harf
  // (tek harfli parça elenir) ve virgül anında siliniyor, alan doldurulamıyordu.
  const [profileDraft, setProfileDraft] = useState<{ departments?: string; skills?: string }>({});
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
      setCandidateProfile({ ...EMPTY_PROFILE, ...(preferences.data.preference.candidateProfile ?? {}) });
      setProfilePersonalizationEnabled(preferences.data.preference.profilePersonalizationEnabled ?? false);
      const stored = preferences.data.preference;
      const storedFilters = stored.filters;
      if (
        storedFilters.employmentTypes.length > 0 ||
        storedFilters.educationLevels.length > 0 ||
        storedFilters.departments.length > 0 ||
        storedFilters.kpssMinScore != null ||
        storedFilters.minDaysUntilDeadline != null ||
        stored.includeWorkerJobs === false ||
        stored.includeAcademicJobs === false
      ) {
        setMoreOpen(true);
      }
      setSettings({
        onlyNewJobs: stored.onlyNewJobs ?? true,
        notifyOnChanges: stored.notifyOnChanges ?? true,
        includeWorkerJobs: stored.includeWorkerJobs ?? true,
        includeAcademicJobs: stored.includeAcademicJobs ?? true,
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

  // Profil ayrı karttadır; sonucu da kendi düğmesinin yanında gösterilir.
  const saveProfile = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.put<{ message: string }>('/api/notifications/preferences', body),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['preferences'] });
    },
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
  const [confirmClearProfile, setConfirmClearProfile] = useState(false);
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
      ...settings,
    });
  };

  const conditionCount = [
    filters.employmentTypes.length,
    filters.educationLevels.length,
    filters.departments.length,
    filters.kpssMinScore === null ? 0 : 1,
    filters.minDaysUntilDeadline === null ? 0 : 1,
    settings.includeWorkerJobs ? 0 : 1,
    settings.includeAcademicJobs ? 0 : 1,
  ].filter((count) => count > 0).length;

  /** Profil onayı/alanları e-posta bildirim aboneliğinden bağımsız kaydedilebilir. */
  const saveProfileOnly = (): void => {
    saveProfile.mutate({ candidateProfile, profilePersonalizationEnabled });
  };

  const clearProfile = (): void => {
    setCandidateProfile({ ...EMPTY_PROFILE });
    setProfilePersonalizationEnabled(false);
    setConfirmClearProfile(false);
    setProfileDraft({});
    saveProfile.mutate({ candidateProfile: { ...EMPTY_PROFILE }, profilePersonalizationEnabled: false });
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
          description="Yazdığınız kelimelerden herhangi biri bir ilanda geçerse e-posta ile haber veririz. Boş bıraktığınız alanlar yok sayılır."
        >
          <form
            className="pref-form"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <section className="pref-section" aria-labelledby="pref-what">
              <h3 id="pref-what" className="pref-section-title">
                Neyi takip ediyorsunuz?
              </h3>
              <p className="text-muted-sm pref-section-note">Birden fazla değeri virgülle ayırın.</p>
              <div className="form-grid-2col">
                <Field label="Anahtar kelimeler" htmlFor="pref-keywords" hint="İlan başlığında ve metninde aranır.">
                  <input
                    id="pref-keywords"
                    className="input"
                    value={draft['keywords'] ?? (preference?.filters.keywords ?? []).join(', ')}
                    onChange={(event) => {
                      setDraft({ ...draft, keywords: event.target.value });
                      setFilters({ ...filters, keywords: toList(event.target.value) });
                    }}
                    placeholder="ör. psikoloji, rehberlik"
                  />
                </Field>
                <Field label="Unvanlar" htmlFor="pref-titles">
                  <input
                    id="pref-titles"
                    className="input"
                    value={draft['titles'] ?? (preference?.filters.titles ?? []).join(', ')}
                    onChange={(event) => {
                      setDraft({ ...draft, titles: event.target.value });
                      setFilters({ ...filters, titles: toList(event.target.value) });
                    }}
                    placeholder="ör. psikolog, hemşire"
                  />
                </Field>
                <Field label="Kurumlar" htmlFor="pref-institutions" hint="Adın bir kısmı yeterli.">
                  <input
                    id="pref-institutions"
                    className="input"
                    value={draft['institutions'] ?? (preference?.filters.institutions ?? []).join(', ')}
                    onChange={(event) => {
                      setDraft({ ...draft, institutions: event.target.value });
                      setFilters({ ...filters, institutions: toList(event.target.value) });
                    }}
                    placeholder="ör. Sağlık Bakanlığı"
                  />
                </Field>
                <Field label="İller" htmlFor="pref-cities">
                  <input
                    id="pref-cities"
                    className="input"
                    value={draft['cities'] ?? (preference?.filters.cities ?? []).join(', ')}
                    onChange={(event) => {
                      setDraft({ ...draft, cities: event.target.value });
                      setFilters({ ...filters, cities: toList(event.target.value) });
                    }}
                    placeholder="Tüm iller"
                  />
                </Field>
              </div>
            </section>

            <details
              className="pref-section pref-more"
              open={moreOpen}
              onToggle={(event) => setMoreOpen(event.currentTarget.open)}
            >
              <summary className="pref-section-title">
                Ek koşullar (isteğe bağlı){conditionCount > 0 ? ` · ${conditionCount} seçili` : ''}
              </summary>
              <div className="pref-more-body">
                <fieldset className="pref-fieldset">
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

                <fieldset className="pref-fieldset">
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

                <div className="pref-grid-3">
                  <Field label="İlanda aranan bölüm" htmlFor="pref-departments" hint="Virgülle ayırın.">
                    <input
                      id="pref-departments"
                      className="input"
                      value={draft['departments'] ?? (preference?.filters.departments ?? []).join(', ')}
                      onChange={(event) => {
                        setDraft({ ...draft, departments: event.target.value });
                        setFilters({ ...filters, departments: toList(event.target.value) });
                      }}
                      placeholder="ör. psikoloji"
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
                      placeholder="ör. 70"
                    />
                  </Field>
                  <Field
                    label="Son başvuruya en az (gün)"
                    htmlFor="pref-days"
                    hint="Çok yakında kapanan ilanları eler."
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
                      placeholder="ör. 3"
                    />
                  </Field>
                </div>

                <div className="switch-list">
                  <label className="switch-row">
                    <input
                      type="checkbox"
                      checked={settings.includeWorkerJobs}
                      onChange={(event) => setSettings({ ...settings, includeWorkerJobs: event.target.checked })}
                    />
                    Kamu işçisi (4/D) ilanlarını dahil et
                  </label>
                  <label className="switch-row">
                    <input
                      type="checkbox"
                      checked={settings.includeAcademicJobs}
                      onChange={(event) => setSettings({ ...settings, includeAcademicJobs: event.target.checked })}
                    />
                    Akademik kadro ilanlarını dahil et
                  </label>
                </div>
              </div>
            </details>

            <section className="pref-section" aria-labelledby="pref-how">
              <h3 id="pref-how" className="pref-section-title">
                Bildirim ayarları
              </h3>
              <div className="switch-list">
                <label className="switch-row">
                  <input
                    type="checkbox"
                    checked={settings.onlyNewJobs}
                    onChange={(event) => setSettings({ ...settings, onlyNewJobs: event.target.checked })}
                  />
                  Yalnızca yeni ilanlar için bildir (sonuç ve atama duyuruları gönderilmez)
                </label>
                <label className="switch-row">
                  <input
                    type="checkbox"
                    checked={settings.notifyOnChanges}
                    onChange={(event) => setSettings({ ...settings, notifyOnChanges: event.target.checked })}
                  />
                  Takip ettiğim ilanda değişiklik olursa (tarih, kontenjan, koşul) bildir
                </label>
              </div>
              {/* Günlük özet henüz gönderilmiyor (toplayıcı görevi yok); yalnızca bu
                  moddaki eski tercihler için durum gösterilir, yeni seçim sunulmaz. */}
              {preference?.mode === 'daily-digest' && (
                <p className="field-hint">
                  Günlük özet henüz kullanılamıyor; bildirimler anında gönderilir.
                </p>
              )}
            </section>

            <div className="pref-save-bar">
              <button type="submit" className="btn-primary" disabled={save.isPending}>
                {save.isPending ? 'Kaydediliyor…' : 'Tercihleri kaydet ve bildirimleri aç'}
              </button>
              <SaveFeedback
                message={save.data?.message ?? null}
                error={save.isError ? errorMessage(save.error) : null}
                pending={save.isPending}
              />
            </div>
          </form>
        </Card>
      )}

      {view === 'preferences' && (
        <Card
          title="Profilim (isteğe bağlı)"
          description="Mesleğinizi ve eğitiminizi girerseniz her ilanda size uyan koşulları gösteririz. Bilgileriniz yalnızca hesabınızda kalır; bildirim tercihlerinizi değiştirmez."
        >
          <form
            className="pref-form"
            onSubmit={(event) => {
              event.preventDefault();
              saveProfileOnly();
            }}
          >
            <label className="switch-row profile-consent-row">
              <input
                type="checkbox"
                checked={profilePersonalizationEnabled}
                onChange={(event) => setProfilePersonalizationEnabled(event.target.checked)}
              />
              Profilimi ilanlara özel eşleşme açıklamalarında kullan
            </label>
            <div className="form-grid-2col profile-form-grid">
              <Field label="Mesleğim / hedef unvanım" htmlFor="profile-profession">
                <input
                  id="profile-profession"
                  className="input"
                  maxLength={100}
                  value={candidateProfile.profession}
                  onChange={(event) => setCandidateProfile({ ...candidateProfile, profession: event.target.value })}
                  placeholder="ör. psikolog"
                />
              </Field>
              <Field label="Eğitim düzeyim" htmlFor="profile-education">
                <select
                  id="profile-education"
                  className="input"
                  value={candidateProfile.educationLevel ?? ''}
                  onChange={(event) =>
                    setCandidateProfile({ ...candidateProfile, educationLevel: event.target.value || null })
                  }
                >
                  <option value="">Belirtmek istemiyorum</option>
                  {EDUCATION_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {EDUCATION_LEVEL_LABELS[level]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Mezun olduğum bölümler" htmlFor="profile-departments" hint="Virgülle ayırın.">
                <input
                  id="profile-departments"
                  className="input"
                  value={profileDraft.departments ?? candidateProfile.departments.join(', ')}
                  onChange={(event) => {
                    setProfileDraft({ ...profileDraft, departments: event.target.value });
                    setCandidateProfile({ ...candidateProfile, departments: toList(event.target.value) });
                  }}
                  placeholder="ör. Psikoloji"
                />
              </Field>
              <Field label="Beceriler / belgeler" htmlFor="profile-skills" hint="Virgülle ayırın.">
                <input
                  id="profile-skills"
                  className="input"
                  value={profileDraft.skills ?? candidateProfile.skills.join(', ')}
                  onChange={(event) => {
                    setProfileDraft({ ...profileDraft, skills: event.target.value });
                    setCandidateProfile({ ...candidateProfile, skills: toList(event.target.value) });
                  }}
                  placeholder="ör. AutoCAD, ilk yardım"
                />
              </Field>
              <Field label="İlgili iş deneyimim (yıl)" htmlFor="profile-experience">
                <input
                  id="profile-experience"
                  className="input"
                  type="number"
                  min={0}
                  max={50}
                  value={candidateProfile.experienceYears ?? ''}
                  onChange={(event) =>
                    setCandidateProfile({
                      ...candidateProfile,
                      experienceYears: event.target.value === '' ? null : Number(event.target.value),
                    })
                  }
                />
              </Field>
            </div>
            <div className="pref-save-bar">
              <button type="submit" className="btn-primary" disabled={saveProfile.isPending}>
                {saveProfile.isPending ? 'Kaydediliyor…' : 'Profili kaydet'}
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setConfirmClearProfile(true)}
                disabled={saveProfile.isPending}
              >
                Profil bilgilerimi sil
              </button>
              <SaveFeedback
                message={saveProfile.data?.message ?? null}
                error={saveProfile.isError ? errorMessage(saveProfile.error) : null}
                pending={saveProfile.isPending}
              />
            </div>
          </form>
        </Card>
      )}

      {view === 'preferences' && <TelegramCard />}
      {view === 'preferences' && <AiSuggestionsCard />}

      {view === 'history' && (
        <Card title="Bildirim geçmişi" description="Size gönderdiğimiz e-postalar.">
          {history.isLoading && <Spinner />}
          {history.isError && (
            <ErrorNotice message={errorMessage(history.error)} onRetry={() => void history.refetch()} />
          )}
          {history.data && (
            <>
              {history.data.events.length === 0 ? (
                <p className="text-muted-sm">Henüz size bildirim gönderilmedi.</p>
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
                </div>
              )}
            </>
          )}
        </Card>
      )}

      {confirmClearProfile && (
        <ConfirmDialog
          title="Profil bilgilerini sil"
          description="Profil alanlarınız kalıcı olarak boşaltılacak ve kişiselleştirme kapatılacak. E-posta bildirim tercihleriniz değişmeyecek."
          confirmLabel="Profilimi sil"
          busy={saveProfile.isPending}
          onConfirm={clearProfile}
          onCancel={() => setConfirmClearProfile(false)}
        />
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
