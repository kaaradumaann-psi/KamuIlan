import type { MouseEvent, ReactNode } from 'react';
import { Icon } from './Icon';
import { POLICY_UPDATED_LABEL } from '../site';

/** Politika belgelerinin ortak yapı taşı: numaralı, başlıklı bir bölüm. */
export type PolicySection = {
  id: string;
  title: string;
  body: ReactNode;
};

type PolicyDocProps = {
  /** Sayfanın giriş paragrafı (belgenin kapsamını özetler). */
  lede: string;
  sections: PolicySection[];
};

function scrollTo(event: MouseEvent<HTMLAnchorElement>, id: string) {
  event.preventDefault();
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * Gizlilik & KVKK Politikası ve Kullanım Koşulları sayfalarının ortak belge
 * düzeni: sabit içindekiler şeridi, numaralandırılmış bölümler ve yürürlük
 * satırı. İçerik metinleri sayfa bileşenlerinde tutulur; bu bileşen yalnızca
 * sunumu düzenler.
 */
export function PolicyDoc({ lede, sections }: PolicyDocProps) {
  return (
    <div className="policy-layout">
      <aside className="policy-toc" aria-label="İçindekiler">
        <span className="policy-toc-heading">İçindekiler</span>
        <ol className="policy-toc-list">
          {sections.map((section, index) => (
            <li key={section.id}>
              <a href={`#${section.id}`} onClick={event => scrollTo(event, section.id)}>
                <span className="policy-toc-no">{String(index + 1).padStart(2, '0')}</span>
                <span>{section.title}</span>
              </a>
            </li>
          ))}
        </ol>
        <span className="policy-toc-updated">{POLICY_UPDATED_LABEL}</span>
      </aside>

      <div className="policy-body">
        <p className="info-lede">{lede}</p>
        {sections.map((section, index) => (
          <section key={section.id} id={section.id} className="policy-section" aria-label={section.title}>
            <h2>
              <span className="policy-section-no">{String(index + 1).padStart(2, '0')}</span>
              {section.title}
            </h2>
            {section.body}
          </section>
        ))}
        <button
          type="button"
          className="policy-back-top"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        >
          <Icon name="left" size={13} />
          <span>Başa dön</span>
        </button>
      </div>
    </div>
  );
}

/** Politika gövdesinde sık kullanılan madde listesi. */
export function PolicyList({ items, ordered }: { items: ReactNode[]; ordered?: boolean }) {
  const Tag = ordered ? 'ol' : 'ul';
  return <Tag className="policy-list">{items.map((item, index) => <li key={index}>{item}</li>)}</Tag>;
}
