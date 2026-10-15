/**
 * Ortak kart atfı (ownCardText): paylaşılan kapsayıcıda komşu ilanın alanları karışmaz;
 * tek ilanlık gerçek kartlar (başlık + "devamı" bağlantısı aynı ilana) korunur.
 */
import { describe, expect, it } from 'vitest';
import { loadHtml } from '../src/lib/html';
import { ownCardText } from '../src/sources/listing-utils';

const idOf = (href: string): string | null => /\/ilan\/(\d+)/.exec(href)?.[1] ?? null;

function anchorFor(html: string, href: string) {
  const $ = loadHtml(html);
  const element = $(`a[href="${href}"]`).first();
  return { $, element };
}

describe('ownCardText', () => {
  it('ayrı kartlarda her ilanın kendi metnini döndürür', () => {
    const html = `<div class="list">
      <div class="card"><a href="/ilan/101">Bilişim Personeli Alım İlanı</a><span>İstanbul</span> 10.10.2026</div>
      <div class="card"><a href="/ilan/102">Memur Alım İlanı</a><span>Ankara</span> 01.09.2026</div>
    </div>`;
    const { $, element } = anchorFor(html, '/ilan/101');
    const text = ownCardText($(element), '.card', idOf, 900) ?? '';
    expect(text).toContain('İstanbul');
    expect(text).toContain('10.10.2026');
    expect(text).not.toContain('Ankara');
    expect(text).not.toContain('01.09.2026');
  });

  it('paylaşılan kapsayıcıda (birden çok farklı ilan) null döner', () => {
    const html = `<div class="shared">
      <a href="/ilan/201">Bilişim Personeli Alım İlanı</a> İstanbul 10.10.2026
      <a href="/ilan/202">Memur Alım İlanı</a> Ankara 01.09.2026
    </div>`;
    const { $, element } = anchorFor(html, '/ilan/201');
    expect(ownCardText($(element), 'div', idOf, 900)).toBeNull();
  });

  it('aynı ilana giden iki bağlantı tek ilan sayılır; kart korunur', () => {
    const html = `<div class="card">
      <a href="/ilan/301">Bilişim Personeli Alım İlanı</a>
      <a href="/ilan/301/detay">Devamı</a>
      <span>İzmir</span> 15.10.2026
    </div>`;
    const { $, element } = anchorFor(html, '/ilan/301');
    const text = ownCardText($(element), 'div', idOf, 900) ?? '';
    expect(text).toContain('İzmir');
    expect(text).toContain('15.10.2026');
  });

  it('ilan olmayan bağlantılar (menü, sayfalama) paylaşım sayılmaz', () => {
    const html = `<div class="card"><a href="/ilan/401">Bilişim Personeli Alım İlanı</a> <a href="/yardim">Yardım</a> Konya 05.10.2026</div>`;
    const { $, element } = anchorFor(html, '/ilan/401');
    const text = ownCardText($(element), 'div', idOf, 900) ?? '';
    expect(text).toContain('Konya');
  });
});
