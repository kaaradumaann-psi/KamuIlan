/**
 * Başlangıç sihirbazı: tercihleri olmayan kullanıcıyı adım adım yönlendirir.
 *
 * Tek soruluk ekranlar, ilerleme göstergesi (Adım X / N), İleri/Geri/Atla ve
 * son adımda "Özet + Tamamla". Tamamlandığında toplanan seçimlerden PUT gövdesi
 * (`buildWizardPayload`) üretilir ve `onComplete`'e verilir — kaydı/yönlendirmeyi
 * çağıran sayfa (Home/Panel) yapar. Tam ekran modal; mobil öncelikli, erişilebilir
 * (odak yönetimi, aria-modal, Esc/Vazgeç ile çıkış, odak tuzağı).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { TagInput } from './TagInput';
import { PROFESSION_SUGGESTIONS } from '../domain/professions';
import { DEPARTMENT_SUGGESTIONS } from '../domain/departments';
import { EDUCATION_LEVELS, EDUCATION_LEVEL_LABELS, EMPLOYMENT_TYPE_LABELS, KPSS_SCORE_TYPES } from '../domain/types';
import type { EmploymentType } from '../domain/types';
import { PROVINCES } from '../domain/provinces';
import {
  buildWizardPayload,
  hasAnyChoice,
  INITIAL_WIZARD_CHOICES,
  type WizardChoices,
  type WizardPayload,
} from '../lib/wizard-payload';

const PROVINCE_NAMES: readonly string[] = PROVINCES.map((province) => province.name);

export interface OnboardingWizardProps {
  onClose: () => void;
  onComplete: (payload: WizardPayload) => void;
  submitting?: boolean;
  error?: string | null;
}

interface StepDef {
  key: string;
  title: string;
  /** Atlanabilir adımlar için "Atla" düğmesi gösterilir. */
  skippable: boolean;
  render: () => ReactNode;
}

export function OnboardingWizard({
  onClose,
  onComplete,
  submitting = false,
  error = null,
}: OnboardingWizardProps): ReactNode {
  const [choices, setChoices] = useState<WizardChoices>(INITIAL_WIZARD_CHOICES);
  const [index, setIndex] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const patch = (next: Partial<WizardChoices>): void => setChoices((current) => ({ ...current, ...next }));

  const toggleEmployment = (value: EmploymentType, checked: boolean): void =>
    patch({
      employmentTypes: checked
        ? [...choices.employmentTypes, value]
        : choices.employmentTypes.filter((item) => item !== value),
    });

  const toggleEducation = (value: string, checked: boolean): void => {
    const educationLevels = checked
      ? [...choices.educationLevels, value]
      : choices.educationLevels.filter((item) => item !== value);
    // Profil eğitim düzeyi: seçilen ilk düzeyle eşlenir (yoksa null).
    patch({ educationLevels, educationLevel: educationLevels[0] ?? null });
  };

  const toggleKpssType = (value: string, checked: boolean): void =>
    patch({
      kpssScoreTypes: checked
        ? [...choices.kpssScoreTypes, value]
        : choices.kpssScoreTypes.filter((item) => item !== value),
    });

  const steps: StepDef[] = useMemo(
    () => [
      {
        key: 'welcome',
        title: 'İlanları size göre süzelim',
        skippable: false,
        render: () => (
          <div className="wizard-welcome">
            <p className="body-copy">
              Birkaç kısa soruyla ilgilendiğiniz kamu ilanlarını tanımlayalım. Yanıtlarınız Panel'deki bildirim
              tercihlerinizi doldurur; eşleşen <strong>yeni ilanlar</strong> çıktığında e-posta ile haber veririz.
            </p>
            <ul className="wizard-points">
              <li>
                <Icon name="check" size={15} />
                <span>
                  Her adımı <strong>atlayabilirsiniz</strong>; hiçbiri zorunlu değil.
                </span>
              </li>
              <li>
                <Icon name="check" size={15} />
                <span>İstediğiniz an sağ üstteki kapatma düğmesiyle çıkabilirsiniz.</span>
              </li>
              <li>
                <Icon name="check" size={15} />
                <span>Seçimleri sonradan Panel'den değiştirebilirsiniz.</span>
              </li>
            </ul>
          </div>
        ),
      },
      {
        key: 'titles',
        title: 'Hangi unvan veya meslek?',
        skippable: true,
        render: () => (
          <WizardQuestion hint="Aradığınız kadro/unvanı yazın ya da listeden seçin. Örn. Hemşire, Zabıta, Mühendis.">
            <TagInput
              id="wizard-titles"
              ariaLabel="Hedef unvanlar"
              values={choices.titles}
              onChange={(titles) => patch({ titles })}
              suggestions={PROFESSION_SUGGESTIONS}
              placeholder="Unvan yazın ve Enter'a basın"
            />
          </WizardQuestion>
        ),
      },
      {
        key: 'keywords',
        title: 'İlan metninde aranacak kelimeler',
        skippable: true,
        render: () => (
          <WizardQuestion hint="Bu kelimelerden herhangi biri ilan başlığında veya metninde geçerse eşleşir. Örn. rehberlik, sözleşmeli.">
            <TagInput
              id="wizard-keywords"
              ariaLabel="Anahtar kelimeler"
              values={choices.keywords}
              onChange={(keywords) => patch({ keywords })}
              placeholder="Kelime yazın ve Enter'a basın"
            />
          </WizardQuestion>
        ),
      },
      {
        key: 'departments',
        title: 'Mezuniyet alanınız / bölümünüz',
        skippable: true,
        render: () => (
          <WizardQuestion hint="İlanda aranan bölümle eşleştirmek için kullanılır. Örn. Hemşirelik, Hukuk, İnşaat Mühendisliği.">
            <TagInput
              id="wizard-departments"
              ariaLabel="Bölümler"
              values={choices.departments}
              onChange={(departments) => patch({ departments })}
              suggestions={DEPARTMENT_SUGGESTIONS}
              placeholder="Bölüm yazın ve Enter'a basın"
            />
          </WizardQuestion>
        ),
      },
      {
        key: 'cities',
        title: 'Hangi il(ler)?',
        skippable: true,
        render: () => (
          <WizardQuestion hint="Boş bırakırsanız tüm iller dahil edilir.">
            <TagInput
              id="wizard-cities"
              ariaLabel="İller"
              values={choices.cities}
              onChange={(cities) => patch({ cities })}
              suggestions={PROVINCE_NAMES}
              maxLength={60}
              placeholder="İl yazın ve Enter'a basın"
            />
          </WizardQuestion>
        ),
      },
      {
        key: 'employment',
        title: 'Çalışma türü',
        skippable: true,
        render: () => (
          <WizardQuestion hint="Birden fazla seçebilirsiniz. Seçmezseniz tüm türler dahil edilir.">
            <div className="chip-row wizard-chip-row">
              {(Object.entries(EMPLOYMENT_TYPE_LABELS) as [EmploymentType, string][]).map(([value, label]) => (
                <label key={value} className="chip">
                  <input
                    type="checkbox"
                    checked={choices.employmentTypes.includes(value)}
                    onChange={(event) => toggleEmployment(value, event.target.checked)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </WizardQuestion>
        ),
      },
      {
        key: 'education',
        title: 'Eğitim düzeyiniz',
        skippable: true,
        render: () => (
          <WizardQuestion hint="İlanın istediği düzeyle eşleştirmek için kullanılır. Birden fazla seçebilirsiniz.">
            <div className="chip-row wizard-chip-row">
              {EDUCATION_LEVELS.map((level) => (
                <label key={level} className="chip">
                  <input
                    type="checkbox"
                    checked={choices.educationLevels.includes(level)}
                    onChange={(event) => toggleEducation(level, event.target.checked)}
                  />
                  {EDUCATION_LEVEL_LABELS[level]}
                </label>
              ))}
            </div>
          </WizardQuestion>
        ),
      },
      {
        key: 'kpss',
        title: 'KPSS puanınız (isteğe bağlı)',
        skippable: true,
        render: () => (
          <WizardQuestion hint="Puan türünüzü seçin ve puanınızı yazın; taban puanı daha yüksek ilanlar elenir.">
            <div className="chip-row wizard-chip-row">
              {KPSS_SCORE_TYPES.map((type) => (
                <label key={type} className="chip">
                  <input
                    type="checkbox"
                    checked={choices.kpssScoreTypes.includes(type)}
                    onChange={(event) => toggleKpssType(type, event.target.checked)}
                  />
                  KPSS {type}
                </label>
              ))}
            </div>
            <div className="form-group wizard-score">
              <label htmlFor="wizard-kpss-score">Asgari KPSS puanınız</label>
              <input
                id="wizard-kpss-score"
                className="input"
                type="number"
                min={0}
                max={100}
                inputMode="decimal"
                value={choices.kpssMinScore ?? ''}
                onChange={(event) =>
                  patch({ kpssMinScore: event.target.value === '' ? null : Number(event.target.value) })
                }
                placeholder="ör. 70"
              />
            </div>
          </WizardQuestion>
        ),
      },
      {
        key: 'notifications',
        title: 'Bildirim ayarları',
        skippable: false,
        render: () => (
          <WizardQuestion hint="Varsayılanlar çoğu kişi için uygundur; dilerseniz değiştirin.">
            <div className="switch-list">
              <label className="switch-row">
                <input
                  type="checkbox"
                  checked={choices.onlyNewJobs}
                  onChange={(event) => patch({ onlyNewJobs: event.target.checked })}
                />
                Yalnızca yeni ilanlar için bildir (sonuç/atama duyuruları gönderilmez)
              </label>
              <label className="switch-row">
                <input
                  type="checkbox"
                  checked={choices.notifyOnChanges}
                  onChange={(event) => patch({ notifyOnChanges: event.target.checked })}
                />
                Takip ettiğim ilanda değişiklik olursa bildir
              </label>
              <label className="switch-row">
                <input
                  type="checkbox"
                  checked={choices.includeWorkerJobs}
                  onChange={(event) => patch({ includeWorkerJobs: event.target.checked })}
                />
                Kamu işçisi (4/D) ilanlarını dahil et
              </label>
              <label className="switch-row">
                <input
                  type="checkbox"
                  checked={choices.includeAcademicJobs}
                  onChange={(event) => patch({ includeAcademicJobs: event.target.checked })}
                />
                Akademik kadro ilanlarını dahil et
              </label>
            </div>
          </WizardQuestion>
        ),
      },
      {
        key: 'summary',
        title: 'Özet',
        skippable: false,
        render: () => <WizardSummary choices={choices} />,
      },
    ],
    [choices],
  );

  const total = steps.length;
  const current = steps[index]!;
  const isLast = index === total - 1;

  // Adım değişince başlığa odaklan (ekran okuyucu bağlamı) ve başa kaydır.
  useEffect(() => {
    headingRef.current?.focus();
    dialogRef.current?.scrollTo?.(0, 0);
  }, [index]);

  // Esc ile çıkış + odak tuzağı (arka plan aria-hidden; klavye modalde kalır).
  useEffect(() => {
    const body = document.body;
    const previousOverflow = body.style.overflow;
    body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !submitting) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const container = dialogRef.current;
      if (!container) return;
      const focusables = [
        ...container.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((element) => element.offsetParent !== null);
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      body.style.overflow = previousOverflow;
    };
  }, [onClose, submitting]);

  const goNext = (): void => setIndex((value) => Math.min(value + 1, total - 1));
  const goBack = (): void => setIndex((value) => Math.max(value - 1, 0));

  const complete = (): void => onComplete(buildWizardPayload(choices));

  return (
    <div
      className="modal-backdrop wizard-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wizard-title"
    >
      <div className="wizard-shell" ref={dialogRef} role="document">
        <header className="wizard-head">
          <div className="wizard-progress">
            <span className="wizard-step-count">
              Adım {index + 1} / {total}
            </span>
            <span className="wizard-progress-track" aria-hidden="true">
              <span className="wizard-progress-fill" style={{ width: `${((index + 1) / total) * 100}%` }} />
            </span>
          </div>
          <button
            type="button"
            className="icon-close-btn"
            onClick={onClose}
            disabled={submitting}
            aria-label="Sihirbazdan vazgeç"
          >
            <Icon name="close" size={18} />
          </button>
        </header>

        <div className="wizard-body">
          <h2 id="wizard-title" className="wizard-title" tabIndex={-1} ref={headingRef}>
            {current.title}
          </h2>
          {current.render()}
          {isLast && error && (
            <p className="form-error push-sm" role="alert">
              Kaydedilemedi: {error}
            </p>
          )}
        </div>

        <footer className="wizard-foot">
          <button type="button" className="btn-ghost" onClick={goBack} disabled={index === 0 || submitting}>
            <Icon name="left" size={15} />
            <span>Geri</span>
          </button>
          <div className="wizard-foot-right">
            {current.skippable && !isLast && (
              <button type="button" className="btn-secondary" onClick={goNext} disabled={submitting}>
                Atla
              </button>
            )}
            {isLast ? (
              <button
                type="button"
                className="btn-primary"
                onClick={complete}
                disabled={submitting || !hasAnyChoice(choices)}
              >
                {submitting ? 'Kaydediliyor…' : 'Tamamla ve bildirimleri aç'}
              </button>
            ) : (
              <button type="button" className="btn-primary" onClick={goNext} disabled={submitting}>
                <span>İleri</span>
                <Icon name="right" size={15} />
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

function WizardQuestion({ hint, children }: { hint: string; children: ReactNode }): ReactNode {
  return (
    <div className="wizard-question">
      <p className="wizard-hint">{hint}</p>
      {children}
    </div>
  );
}

function SummaryRow({ label, values }: { label: string; values: string[] }): ReactNode {
  return (
    <div className="wizard-summary-row">
      <dt>{label}</dt>
      <dd>{values.length > 0 ? values.join(', ') : <span className="text-muted-sm">Belirtilmedi</span>}</dd>
    </div>
  );
}

function WizardSummary({ choices }: { choices: WizardChoices }): ReactNode {
  const empty = !hasAnyChoice(choices);
  return (
    <div className="wizard-question">
      <p className="wizard-hint">
        Seçimlerinizi kontrol edin. "Tamamla" ile tercihler kaydedilir ve bildirimler açılır.
      </p>
      <dl className="wizard-summary">
        <SummaryRow label="Unvan / meslek" values={choices.titles} />
        <SummaryRow label="Anahtar kelimeler" values={choices.keywords} />
        <SummaryRow label="Bölümler" values={choices.departments} />
        <SummaryRow label="İller" values={choices.cities} />
        <SummaryRow
          label="Çalışma türü"
          values={choices.employmentTypes.map((type) => EMPLOYMENT_TYPE_LABELS[type])}
        />
        <SummaryRow
          label="Eğitim düzeyi"
          values={choices.educationLevels.map(
            (level) => EDUCATION_LEVEL_LABELS[level as keyof typeof EDUCATION_LEVEL_LABELS] ?? level,
          )}
        />
        <SummaryRow
          label="KPSS"
          values={[
            ...choices.kpssScoreTypes.map((type) => `KPSS ${type}`),
            ...(choices.kpssMinScore !== null ? [`asgari ${choices.kpssMinScore}`] : []),
          ]}
        />
      </dl>
      {empty && (
        <p className="wizard-hint" role="status">
          En az bir tercih seçerseniz tamamlayabilirsiniz. Geri dönüp bir unvan, kelime ya da il ekleyin.
        </p>
      )}
    </div>
  );
}
