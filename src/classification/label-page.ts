/**
 * Teknik olmayan biri için çevrimdışı etiketleme sayfası (`npm run eval:label-page`).
 *
 * Neden: insan etiketi (gerçek doğruluk ölçümünün tek dayanağı) JSON düzenlemeyi gerektiriyordu.
 * Sayfa tek dosyadır, dış kaynak yüklemez; ilerleme tarayıcıda saklanır; "Dışa aktar" aynı çalışma
 * sayfasını doldurulmuş hâliyle indirir → `npm run eval:build-set -- --import <dosya>`.
 *
 * Yanlılık önlemi: sistemin tahmini varsayılan olarak GİZLİ (etiketleyeni yönlendirmesin).
 * Kanıt zorunlu: kullanıcı alıntıdan metin seçer (≥ 20 karakter), resmî bağlantı otomatik eklenir.
 */

export const LABEL_CHOICES: readonly { value: string; label: string; hint: string }[] = [
  { value: 'personnel_recruitment', label: 'Personel alım ilanı', hint: 'Yeni başvuru alınan kadro/pozisyon ilanı' },
  { value: 'personnel_process_announcement', label: 'Süreç duyurusu', hint: 'Sınav yeri, sonuç, kura, mülakat, atama…' },
  { value: 'student_admission', label: 'Öğrenci alımı / burs', hint: 'Öğrenci, kursiyer, stajyer, burs' },
  { value: 'education_program', label: 'Eğitim programı', hint: 'Kurs, seminer, eğitim duyurusu' },
  { value: 'news', label: 'Haber', hint: 'Kurum haberi, ziyaret, açıklama' },
  { value: 'event', label: 'Etkinlik', hint: 'Konferans, tören, toplantı' },
  { value: 'report_or_publication', label: 'Rapor / yayın', hint: 'Rapor, bülten, istatistik' },
  { value: 'other', label: 'Diğer', hint: 'İhale, mevzuat, başka bir şey' },
];

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);

/** `</script>` kapanışını kıran içerik veriye gömülürken etkisizleştirilir. */
const safeJson = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');

export function renderLabelPage(worksheet: { records: unknown[] }): string {
  const choices = LABEL_CHOICES.map(
    (choice) => `<button type="button" class="choice" data-value="${choice.value}" title="${escapeHtml(choice.hint)}">${escapeHtml(choice.label)}</button>`,
  ).join('');
  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kamuİlan — ilan etiketleme</title>
<style>
:root{--ink:#14161a;--muted:#5b6270;--line:#e3e6ea;--accent:#0b63e5;--ok:#137333;--bg:#f6f7f9}
*{box-sizing:border-box}body{margin:0;font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg)}
header{position:sticky;top:0;background:#fff;border-bottom:1px solid var(--line);padding:12px 20px;display:flex;gap:16px;align-items:center;flex-wrap:wrap;z-index:2}
header h1{font-size:17px;margin:0}header .grow{flex:1}input,textarea{font:inherit;border:1px solid var(--line);border-radius:8px;padding:7px 10px}
main{max-width:860px;margin:0 auto;padding:20px}.help{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px 18px;margin-bottom:18px;color:var(--muted)}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:16px}.card.done{border-color:#9fd3ad}
.meta{color:var(--muted);font-size:13px}.title{font-weight:650;font-size:16px;margin:4px 0 6px}
.excerpt{white-space:pre-wrap;background:var(--bg);border-radius:8px;padding:10px 12px;margin:10px 0;max-height:260px;overflow:auto;cursor:text}
.choices{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}.choice{border:1px solid var(--line);background:#fff;border-radius:999px;padding:7px 14px;font:inherit;cursor:pointer}
.choice[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:#fff}textarea{width:100%;min-height:52px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.btn{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:9px 16px;font:inherit;cursor:pointer}
.btn.secondary{background:#fff;color:var(--ink);border:1px solid var(--line)}.status{font-size:13px;color:var(--ok)}.warn{color:#b3261e;font-size:13px}
details{margin-top:8px;color:var(--muted);font-size:13px}a{color:var(--accent)}
</style></head><body>
<header><h1>İlan etiketleme</h1><span class="grow"></span>
<label>Adınız <input id="who" placeholder="ör. Halil" autocomplete="name"></label>
<span id="progress" class="meta"></span>
<button class="btn" id="export" type="button">Dışa aktar (JSON indir)</button></header>
<main>
<div class="help"><strong>Nasıl yapılır?</strong> Her kayıtta <em>Resmî kaynağı aç</em> ile ilanı okuyun, uygun düğmeye basın.
Kararınızı destekleyen bir cümleyi alıntı kutusunda <strong>fareyle seçin</strong>: kanıt kutusu kendiliğinden dolar (en az 20 karakter).
Emin değilseniz kaydı boş bırakın; boş kayıtlar ölçüme girmez. İlerlemeniz bu tarayıcıda saklanır.
Bitirince <strong>Dışa aktar</strong>'a basın ve indirilen dosyayı Claude Code'a verin.</div>
<div id="list"></div></main>
<script>
const WORKSHEET = ${safeJson(worksheet)};
const CHOICES_HTML = ${safeJson(choices)};
const KEY = 'kamuilan-etiket-' + (WORKSHEET.generatedAt || 'v1');
let state = {}; try { state = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}
const who = document.getElementById('who'); who.value = state.__who || '';
who.addEventListener('input', () => { state.__who = who.value; save(); });
function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} render(); }
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
function card(record) {
  const s = state[record.id] || {}; const c = el('section', 'card' + (s.type && (s.quote || '').length >= 20 ? ' done' : ''));
  c.appendChild(el('div', 'meta', (record.institution || '') + ' · ' + record.sourceKey));
  c.appendChild(el('div', 'title', record.title));
  const link = el('a', null, 'Resmî kaynağı aç ↗'); link.href = record.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; c.appendChild(link);
  const ex = el('div', 'excerpt', record.bodyExcerpt || '(alıntı yok — resmî kaynaktan okuyun)'); c.appendChild(ex);
  const box = el('div', 'choices'); box.innerHTML = CHOICES_HTML;
  box.querySelectorAll('.choice').forEach((b) => { b.setAttribute('aria-pressed', String(b.dataset.value === s.type));
    b.onclick = () => { state[record.id] = Object.assign({}, state[record.id], { type: b.dataset.value }); save(); }; });
  c.appendChild(box);
  const q = el('textarea'); q.placeholder = 'Kanıt: ilandan kararınızı destekleyen cümle (alıntıda metni seçince dolar)'; q.value = s.quote || '';
  q.onchange = () => { state[record.id] = Object.assign({}, state[record.id], { quote: q.value.trim() }); save(); };
  ex.addEventListener('mouseup', () => { const t = String(window.getSelection() || '').trim(); if (t.length >= 20) { state[record.id] = Object.assign({}, state[record.id], { quote: t.slice(0, 1000) }); save(); } });
  c.appendChild(q);
  const row = el('div', 'row');
  if (s.type && (s.quote || '').length < 20) row.appendChild(el('span', 'warn', 'Kanıt en az 20 karakter olmalı.'));
  if (s.type || s.quote) { const clear = el('button', 'btn secondary', 'Temizle'); clear.type = 'button'; clear.onclick = () => { delete state[record.id]; save(); }; row.appendChild(clear); }
  c.appendChild(row);
  const d = el('details'); d.appendChild(el('summary', null, 'Sistemin tahminini göster (önce kendi kararınızı verin)'));
  d.appendChild(el('div', null, (record.machineSuggestion && record.machineSuggestion.contentType) + ' · ' + ((record.machineSuggestion && record.machineSuggestion.reasons) || []).join('; ')));
  c.appendChild(d);
  return c;
}
function render() {
  const list = document.getElementById('list'); const y = window.scrollY; list.textContent = '';
  WORKSHEET.records.forEach((r) => list.appendChild(card(r)));
  const done = WORKSHEET.records.filter((r) => state[r.id] && state[r.id].type && (state[r.id].quote || '').length >= 20).length;
  document.getElementById('progress').textContent = done + ' / ' + WORKSHEET.records.length + ' tamam';
  window.scrollTo(0, y);
}
document.getElementById('export').onclick = () => {
  if (!who.value.trim()) { alert('Önce adınızı yazın.'); who.focus(); return; }
  const now = new Date().toISOString();
  const records = WORKSHEET.records.map((r) => { const s = state[r.id];
    if (!s || !s.type || (s.quote || '').length < 20) return r;
    return Object.assign({}, r, { expectedContentType: s.type, labelProvenance: 'human', labeledBy: who.value.trim(), labeledAt: now,
      labelEvidence: { sourceUrl: r.url, quote: s.quote, locator: '' } }); });
  const blob = new Blob([JSON.stringify(Object.assign({}, WORKSHEET, { records: records }), null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'eval-worksheet-etiketli.json'; a.click();
};
render();
</script></body></html>
`;
}
