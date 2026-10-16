/**
 * İlan kalitesi tanısı — SALT OKUMA.
 *
 * Amaç: kullanıcının gerçek veritabanındaki (Supabase/Postgres ya da dosya)
 * kayıtları inceleyip "yanlış ilanlar nereden geliyor?" sorusunu kanıtla
 * yanıtlamak. Bu araç HİÇBİR ŞEY YAZMAZ: yalnızca `find`/`count` kullanır,
 * indeks oluşturmaz, migration çalıştırmaz, kayıt güncellemez/silmez.
 *
 * Kullanım (proje kökünde):
 *   npm run tani:ilan                                  → insan okur özet (en yeni 3000 kayıt)
 *   npm run tani:ilan -- --limit 8000                  → daha geniş tarama
 *   npm run tani:ilan -- --json data\ilan-tanisi.json  → aynı raporu JSON olarak da yaz
 *   npm run tani:ilan -- --bayat-gun 120               → "eski kayıt yeni keşfedildi" eşiği
 *
 * Gizlilik: çıktıda yalnızca ilan başlığı, kurum, tarih, karar ve kaynak anahtarı
 * bulunur; kişisel veri, e-posta, parola, API anahtarı veya .env değeri YAZILMAZ.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLASSIFICATION_VERSION } from '../src/config/app';
import { getEnv } from '../src/config/env';
import { createRepos } from '../src/db/repos';
import type { JobDoc, ReviewQueueDoc, SourceDoc } from '../src/db/schemas';
import { closeStore, describeDriver, effectiveDriver, initStore } from '../src/db/store';
import { UI_CHROME_PHRASES } from '../src/domain/text';
import { APPLICATION_URL_HOSTS } from '../src/extraction/dictionaries';

interface Options {
  limit: number;
  staleDays: number;
  reportPath: string | null;
}

function parseOptions(argv: string[]): Options {
  const value = (flag: string): string | null | undefined => {
    const index = argv.indexOf(flag);
    if (index < 0) return undefined;
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) return null;
    return next;
  };
  const limitRaw = value('--limit');
  const staleRaw = value('--bayat-gun');
  const reportRaw = value('--json');
  return {
    limit: limitRaw ? Math.max(1, Number(limitRaw)) : 3000,
    staleDays: staleRaw ? Math.max(1, Number(staleRaw)) : 90,
    reportPath: reportRaw ? resolve(reportRaw) : null,
  };
}

const DAY_MS = 86_400_000;

function yearsBetween(dateOnly: string, todayDateOnly: string): number {
  return Number(todayDateOnly.slice(0, 4)) - Number(dateOnly.slice(0, 4));
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / DAY_MS);
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

function short(value: string, max = 78): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function pct(part: number, total: number): string {
  if (total === 0) return '—';
  return `${((part / total) * 100).toFixed(1)}%`;
}

function countBy<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    const value = key(item);
    map.set(value, (map.get(value) ?? 0) + 1);
  }
  return map;
}

function topEntries(map: Map<string, number>, limit = 12): [string, number][] {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

const TR_MONTHS = [
  'Ocak',
  'Şubat',
  'Mart',
  'Nisan',
  'Mayıs',
  'Haziran',
  'Temmuz',
  'Ağustos',
  'Eylül',
  'Ekim',
  'Kasım',
  'Aralık',
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Kayıttaki yayım tarihinin metinde GEÇTİĞİ yeri ve çevresini gösterir.
 *
 * Neden gerekli: `publishedAt` bir yasal atıftan ("26.09.2004 tarihli ve 25585
 * sayılı Yönetmelik") okunmuş olabilir. Bu durumda ilan 2026'da yayımlanmış
 * olsa bile kayıt 2004 tarihli görünür ve yanlışlıkla "süresi geçmiş" sayılır.
 * Alıntı, kök nedeni kanıtlamak (ya da çürütmek) için yazdırılır.
 */
function dateEvidence(excerpt: string, iso: string): string | null {
  const dateOnly = iso.slice(0, 10);
  const [year, month, day] = dateOnly.split('-');
  if (!year || !month || !day) return null;
  const dayNumber = String(Number(day));
  const monthNumber = String(Number(month));
  const monthName = TR_MONTHS[Number(month) - 1] ?? '';
  const forms = [
    `${day}.${month}.${year}`,
    `${day}/${month}/${year}`,
    `${dayNumber}.${monthNumber}.${year}`,
    `${dayNumber}/${monthNumber}/${year}`,
    ...(monthName ? [`${dayNumber} ${monthName} ${year}`] : []),
    `${dayNumber} ${month} ${year}`,
  ];
  const text = excerpt.replace(/\s+/g, ' ');
  if (!text) return null;
  for (const form of forms) {
    const match = new RegExp(escapeRegExp(form), 'iu').exec(text);
    if (!match || match.index === undefined) continue;
    const start = Math.max(0, match.index - 95);
    const end = Math.min(text.length, match.index + form.length + 95);
    return `…${text.slice(start, end).trim()}…`;
  }
  const yearOnly = new RegExp(`\\b${escapeRegExp(year)}\\b`).exec(text);
  if (yearOnly && yearOnly.index !== undefined) {
    const start = Math.max(0, yearOnly.index - 95);
    const end = Math.min(text.length, yearOnly.index + year.length + 95);
    return `(yalnızca yıl geçiyor) …${text.slice(start, end).trim()}…`;
  }
  return null;
}

interface Finding {
  code: string;
  label: string;
  job: JobDoc;
  detail: string;
  evidence?: string | null;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const env = getEnv();
  const driver = effectiveDriver(env);
  const store = await initStore(undefined, { ensureIndexes: false });
  createRepos(store);

  const now = new Date();
  const today = new Date(now.getTime() + 3 * 3_600_000).toISOString().slice(0, 10); // Europe/Istanbul günü

  const [jobs, sources, review] = await Promise.all([
    store.find('jobs', {}, { limit: options.limit, sort: [['createdAt', -1]] }) as Promise<JobDoc[]>,
    store.find('sources', {}, { limit: 500 }) as Promise<SourceDoc[]>,
    store.find('reviewQueue', {}, { limit: 1000, sort: [['createdAt', -1]] }) as Promise<ReviewQueueDoc[]>,
  ]);

  const lines: string[] = [];
  const findings: Finding[] = [];
  const push = (code: string, label: string, job: JobDoc, detail: string, evidence?: string | null) =>
    findings.push({ code, label, job, detail, evidence: evidence ?? null });

  lines.push('');
  lines.push('════════════════════════════════════════════════════════════════');
  lines.push('  Kamuİlan — İlan kalitesi tanısı (SALT OKUMA, hiçbir şey yazılmadı)');
  lines.push('════════════════════════════════════════════════════════════════');
  lines.push(`  Tarih          : ${now.toISOString()}`);
  lines.push(`  Veritabanı     : ${describeDriver(driver)}`);
  lines.push(`  Kural sürümü   : ${CLASSIFICATION_VERSION} (kayıtlardaki sürümle karşılaştırılır)`);
  lines.push(`  Taranan kayıt  : ${jobs.length} (en yeni ${options.limit} ilan)`);
  lines.push('');

  // ---------------------------------------------------------------- genel
  lines.push('1) GENEL SAYILAR');
  lines.push(`   İlan (jobs)      : ${jobs.length}`);
  const byDecision = countBy(jobs, (job) => job.classification.decision);
  const byKind = countBy(jobs, (job) => job.classification.kind ?? 'job');
  const byStatus = countBy(jobs, (job) => job.status);
  const byProvenance = countBy(jobs, (job) => job.provenance);
  const byVersion = countBy(jobs, (job) => job.classification.version);
  lines.push(
    `   karar            : ` +
      [...byDecision.entries()].map(([key, value]) => `${key}=${value}`).join(' · '),
  );
  lines.push(`   tür              : ` + [...byKind.entries()].map(([k, v]) => `${k}=${v}`).join(' · '));
  lines.push(`   durum            : ` + [...byStatus.entries()].map(([k, v]) => `${k}=${v}`).join(' · '));
  lines.push(`   kaynak türü      : ` + [...byProvenance.entries()].map(([k, v]) => `${k}=${v}`).join(' · '));
  lines.push('');
  lines.push('   Sınıflandırma sürümüne göre kayıtlar (eski sürüm = yeniden sınıflandırma gerekir):');
  for (const [version, count] of topEntries(byVersion, 6)) {
    const mark = version === CLASSIFICATION_VERSION ? 'güncel' : 'ESKİ';
    lines.push(`     ${version.padEnd(10)} ${String(count).padStart(5)}  ${mark}`);
  }
  const staleVersion = jobs.filter((job) => job.classification.version !== CLASSIFICATION_VERSION);
  lines.push(
    `   → ${staleVersion.length} kayıt eski kural sürümüyle sınıflandırılmış (${pct(staleVersion.length, jobs.length)})`,
  );
  lines.push('');

  // ------------------------------------------------------------- tarihler
  lines.push('2) TARİH DAĞILIMI');
  const publishedYears = countBy(
    jobs.filter((job) => job.publishedAt),
    (job) => String(job.publishedAt).slice(0, 4),
  );
  const seenYears = countBy(jobs, (job) => job.createdAt.slice(0, 4));
  lines.push(
    '   Yayım yılı (publishedAt) : ' +
      [...publishedYears.entries()].sort().map(([k, v]) => `${k}=${v}`).join(' · '),
  );
  lines.push(
    '   Sisteme ilk görülme yılı : ' + [...seenYears.entries()].sort().map(([k, v]) => `${k}=${v}`).join(' · '),
  );
  const noPublished = jobs.filter((job) => !job.publishedAt).length;
  const noEndDate = jobs.filter((job) => !job.applicationEndDate).length;
  lines.push(`   Yayım tarihi yok         : ${noPublished} (${pct(noPublished, jobs.length)})`);
  lines.push(`   Son başvuru tarihi yok   : ${noEndDate} (${pct(noEndDate, jobs.length)})`);
  lines.push('');

  // ------------------------------------------------------------ şüpheliler
  const chromePattern = new RegExp(
    UI_CHROME_PHRASES.map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'i',
  );
  for (const job of jobs) {
    const title = job.title ?? '';
    const institution = job.institution ?? '';
    const published = job.publishedAt ? String(job.publishedAt).slice(0, 10) : null;

    if (chromePattern.test(title) || chromePattern.test(institution)) {
      push('T1', 'Başlık/kurumda sayfa kabuğu (menü, oturum, çerez) ifadesi', job, `başlık="${short(title, 60)}"`);
    }
    if (published && yearsBetween(published, today) >= 2) {
      push(
        'T2',
        'Yayım tarihi 2+ yıl eski (arşiv içerik 2026 listesinde)',
        job,
        `publishedAt=${published}`,
        dateEvidence(job.textExcerpt ?? '', job.publishedAt ?? ''),
      );
    }
    if (published) {
      const gap = daysBetween(`${published}T00:00:00Z`, job.createdAt);
      if (gap > options.staleDays) {
        push(
          'T3',
          `Eski içerik sonradan keşfedilmiş (yayım → ilk görülme > ${options.staleDays} gün)`,
          job,
          `publishedAt=${published} · ilk görülme=${job.createdAt.slice(0, 10)} · fark=${gap} gün`,
          dateEvidence(job.textExcerpt ?? '', job.publishedAt ?? ''),
        );
      }
    }
    if (!job.applicationEndDate && (job.status === 'active' || job.status === 'upcoming')) {
      push('T4', 'Son başvuru tarihi YOK ama durum "açık/başlamadı"', job, `status=${job.status}`);
    }
    if (job.status === 'unknown') {
      const age = daysBetween(job.createdAt, now.toISOString());
      if (age > 60) push('T5', 'Durum 60+ gündür "belirsiz" (hiç kapanmamış)', job, `yaş=${age} gün`);
    }
    if (institution.length < 6 || /^(anasayfa|duyurular|menü|menu|kurumsal)$/i.test(institution.trim())) {
      push('T6', 'Kurum alanı boş/jenerik', job, `kurum="${short(institution, 40)}"`);
    }
    if (job.applicationUrl) {
      const host = hostOf(job.applicationUrl);
      const allowed = host
        ? APPLICATION_URL_HOSTS.some((base) => host === base || host.endsWith(`.${base}`))
        : false;
      if (!allowed) push('T7', 'Başvuru bağlantısı beyaz listede olmayan alan adı', job, `host=${host ?? 'geçersiz'}`);
    }
    const bodyLength = (job.textExcerpt ?? '').length;
    if (bodyLength < 200) {
      push('T8', 'Kanıt metni çok kısa (<200 karakter) ama kayıt yayında', job, `metin=${bodyLength} karakter`);
    }
    const year = published ? Number(published.slice(0, 4)) : null;
    if (year !== null && Number.isFinite(year) && year > Number(today.slice(0, 4))) {
      push('T9', 'Yayım tarihi gelecekte', job, `publishedAt=${published}`);
    }
  }

  // Kopya şüphesi: aynı normalleşmiş başlık + kurum, farklı kayıt kimliği
  const duplicateGroups = new Map<string, JobDoc[]>();
  for (const job of jobs) {
    const key = `${job.titleNormalized}|${job.institutionNormalized}`;
    const group = duplicateGroups.get(key) ?? [];
    group.push(job);
    duplicateGroups.set(key, group);
  }
  const duplicates = [...duplicateGroups.values()].filter((group) => group.length > 1);
  for (const group of duplicates.slice(0, 10)) {
    const first = group[0];
    if (!first) continue;
    push(
      'T10',
      'Aynı başlık + kurum birden fazla kayıtta (kopya şüphesi)',
      first,
      `${group.length} kayıt · id'ler: ${group.map((job) => job.id.slice(-6)).join(', ')} · url'ler: ${group
        .map((job) => hostOf(job.detailUrl) ?? '?')
        .join(', ')}`,
    );
  }

  const sameDateBySource = new Map<string, JobDoc[]>();
  for (const job of jobs) {
    if (!job.publishedAt) continue;
    const key = `${job.primarySourceKey}|${String(job.publishedAt).slice(0, 10)}`;
    const group = sameDateBySource.get(key) ?? [];
    group.push(job);
    sameDateBySource.set(key, group);
  }
  const repeatedDateGroups = [...sameDateBySource.values()].filter((group) => group.length >= 5);
  for (const group of repeatedDateGroups) {
    const first = group[0];
    if (!first) continue;
    push(
      'T11',
      'Aynı kaynakta 5+ kayıt aynı yayım tarihinde (liste sayfası tarihi şüphesi)',
      first,
      `${group.length} kayıt · publishedAt=${String(first.publishedAt).slice(0, 10)} · kaynak=${first.primarySourceKey}`,
      dateEvidence(first.textExcerpt ?? '', first.publishedAt ?? ''),
    );
  }

  lines.push('3) ŞÜPHELİ KAYIT SINIFLARI');  if (findings.length === 0) {
    lines.push('   Şüpheli kayıt bulunamadı.');
  } else {
    const byCode = countBy(findings, (finding) => `${finding.code} ${finding.label}`);
    for (const [label, count] of topEntries(byCode, 20)) {
      lines.push(`   ${String(count).padStart(5)}  ${label}`);
    }
  }
  lines.push(`   Toplam işaretli kayıt: ${new Set(findings.map((finding) => finding.job.id)).size}`);
  lines.push(`   Kopya şüphesi grupları: ${duplicates.length}`);
  lines.push('');

  lines.push('4) ŞÜPHELİ KAYITLARDAN ÖRNEKLER (en yeni 25)');
  const seen = new Set<string>();
  let printed = 0;
  for (const finding of findings) {
    if (seen.has(finding.job.id)) continue;
    seen.add(finding.job.id);
    if (printed >= 25) break;
    printed += 1;
    const job = finding.job;
    lines.push(
      `   [${finding.code}] ${short(job.title, 66)}\n` +
        `        kurum=${short(job.institution, 50)} · tür=${job.classification.kind ?? 'job'} · durum=${job.status}` +
        ` · karar=${job.classification.decision}\n` +
        `        yayım=${job.publishedAt ? String(job.publishedAt).slice(0, 10) : '—'} · son başvuru=${
          job.applicationEndDate ?? '—'
        } · kaynak=${job.primarySourceKey}\n` +
        `        neden: ${finding.detail}\n` +
        `        url=${short(job.detailUrl, 96)}`,
    );
  }
  lines.push('');

  // ------------------------------------------------------------- kaynaklar
  lines.push('5) KAYNAK SAĞLIĞI VE ÜRETİM');
  const jobsBySource = new Map<string, number>();
  for (const job of jobs) {
    for (const key of job.sourceKeys) jobsBySource.set(key, (jobsBySource.get(key) ?? 0) + 1);
  }
  const sourceRows = sources.map((source) => ({
    key: source.key,
    enabled: source.enabled,
    jobs: jobsBySource.get(source.key) ?? 0,
    lastSuccess: source.health?.lastSuccessAt ? String(source.health.lastSuccessAt).slice(0, 16) : '—',
    failures: source.health?.consecutiveFailures ?? 0,
    errorType: source.health?.lastErrorType ?? '—',
    error: source.health?.lastErrorMessage ? short(String(source.health.lastErrorMessage), 46) : '—',
  }));
  const activeSources = sourceRows.filter((row) => row.enabled);
  const failingSources = activeSources.filter((row) => row.failures > 0);
  lines.push(`   Kayıtlı kaynak: ${sourceRows.length} · etkin: ${activeSources.length} · üst üste hatalı: ${failingSources.length}`);
  lines.push('   Kayıt üreten etkin kaynaklar (ilk 15):');
  for (const row of activeSources.filter((item) => item.jobs > 0).sort((a, b) => b.jobs - a.jobs).slice(0, 15)) {
    lines.push(`     ${String(row.jobs).padStart(5)}  ${row.key.padEnd(34)} son başarı=${row.lastSuccess}`);
  }
  const zeroSources = activeSources.filter((row) => row.jobs === 0);
  lines.push(`   Hiç kayıt üretmemiş etkin kaynak: ${zeroSources.length}/${activeSources.length}`);
  for (const row of zeroSources.slice(0, 12)) {
    lines.push(
      `     ${row.key.padEnd(34)} hata=${row.failures} tür=${row.errorType} son mesaj="${row.error}"`,
    );
  }
  lines.push('');

  // --------------------------------------------------------- inceleme kuyruğu
  lines.push('6) İNCELEME KUYRUĞU (sınıflandırma kapısının bıraktığı belirsizler)');
  const openReview = review.filter((item) => item.status === 'open');
  const byReviewKind = countBy(openReview, (item) => item.kind);
  lines.push(
    `   Açık kayıt: ${openReview.length}/${review.length} · tür dağılımı: ` +
      [...byReviewKind.entries()].map(([key, value]) => `${key}=${value}`).join(' · '),
  );
  const reasonWords = new Map<string, number>();
  for (const item of openReview) {
    const reason = String(item.reason ?? '').split('•')[0]?.trim();
    if (!reason) continue;
    reasonWords.set(reason, (reasonWords.get(reason) ?? 0) + 1);
  }
  for (const [reason, count] of topEntries(reasonWords, 8)) {
    lines.push(`     ${String(count).padStart(5)}  ${short(reason, 88)}`);
  }
  lines.push('');

  // ------------------------------------------------- tarih kanıtı (kök neden)
  lines.push('7) YAYIM TARİHİ KANITI (eski tarihli kayıtlar: tarih metinde nereden okunmuş?)');
  const datedFindings = findings.filter(
    (finding) => (finding.code === 'T2' || finding.code === 'T3') && finding.job.publishedAt,
  );
  const printedEvidence = new Set<string>();
  let evidenceLines = 0;
  for (const finding of datedFindings) {
    if (printedEvidence.has(finding.job.id) || evidenceLines >= 12) continue;
    printedEvidence.add(finding.job.id);
    evidenceLines += 1;
    const job = finding.job;
    const sourceKind = job.fieldSources?.publishedAt?.kind ?? 'bilinmiyor';
    lines.push(
      `   ${short(job.title, 62)}\n` +
        `     publishedAt=${String(job.publishedAt).slice(0, 10)} · alan kaynağı=${sourceKind} · durum=${job.status}` +
        ` · kaynak=${job.primarySourceKey}`,
    );
    lines.push(`     metin: ${finding.evidence ?? 'metinde bulunamadı (kaynak/başlık katmanından gelmiş olabilir)'}`);
  }
  if (evidenceLines === 0) lines.push('   Eski tarihli kayıt yok.');
  lines.push('');

  // ------------------------------------------------------------------ özet
  const verdict =
    findings.length === 0 && duplicates.length === 0 && staleVersion.length === 0
      ? 'ÖLÇÜLEN SINIFLARDA SORUN GÖRÜLMEDİ'
      : 'YUKARIDAKİ SINIFLARDA İNCELENECEK KAYIT VAR';
  lines.push(`SONUÇ: ${verdict}`);
  lines.push(`  Eski kural sürümü : ${staleVersion.length}`);
  lines.push(`  İşaretli kayıt    : ${new Set(findings.map((finding) => finding.job.id)).size}`);
  lines.push(`  Kopya şüphesi     : ${duplicates.length} grup`);
  lines.push('  Bu araç hiçbir kaydı DEĞİŞTİRMEDİ/SİLMEDİ (yalnızca okuma).');
  lines.push('');

  process.stdout.write(lines.join('\n'));

  if (options.reportPath) {
    writeFileSync(
      options.reportPath,
      JSON.stringify(
        {
          generatedAt: now.toISOString(),
          database: describeDriver(driver),
          classificationVersion: CLASSIFICATION_VERSION,
          scannedJobs: jobs.length,
          totals: {
            byDecision: Object.fromEntries(byDecision),
            byKind: Object.fromEntries(byKind),
            byStatus: Object.fromEntries(byStatus),
            byProvenance: Object.fromEntries(byProvenance),
            byVersion: Object.fromEntries(byVersion),
            publishedYears: Object.fromEntries(publishedYears),
            seenYears: Object.fromEntries(seenYears),
          },
          staleClassificationRecords: staleVersion.length,
          duplicateGroups: duplicates.map((group) => ({
            title: group[0]?.title ?? '',
            institution: group[0]?.institution ?? '',
            ids: group.map((job) => job.id),
            urls: group.map((job) => job.detailUrl),
          })),
          findings: findings.map((finding) => ({
            code: finding.code,
            label: finding.label,
            detail: finding.detail,
            evidence: finding.evidence ?? null,
            publishedAtSourceKind: finding.job.fieldSources?.publishedAt?.kind ?? null,
            id: finding.job.id,
            title: finding.job.title,
            institution: finding.job.institution,
            status: finding.job.status,
            kind: finding.job.classification.kind ?? 'job',
            decision: finding.job.classification.decision,
            publishedAt: finding.job.publishedAt,
            applicationEndDate: finding.job.applicationEndDate,
            sourceKey: finding.job.primarySourceKey,
            detailUrl: finding.job.detailUrl,
          })),
          openReview: openReview.map((item) => ({
            id: item.id,
            kind: item.kind,
            url: item.url,
            reason: item.reason,
          })),
          sources: sourceRows,
        },
        null,
        1,
      ),
    );
    process.stdout.write(`JSON raporu yazıldı: ${options.reportPath}\n`);
  }

  await closeStore();
}

main().catch((error) => {
  process.stderr.write(`Tanı çalıştırılamadı: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
