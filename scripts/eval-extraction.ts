#!/usr/bin/env node
/**
 * Alan çıkarımı değerlendirmesi (ayrı, çevrimdışı, ücretsiz).
 *
 *   npm run eval:extraction
 *   npm run eval:extraction -- --file tests/fixtures/eval/labeled-set.json --json artifacts/eval-extraction.json
 *
 * Kurallar:
 *  - İnternet, LLM sağlayıcısı, e-posta/Telegram ve veritabanı KULLANILMAZ.
 *  - Yüzdeler yalnızca `origin: "real"` + `labelProvenance: "human"` + tam gövde
 *    (>=200 karakter) kayıtlardan üretilir. Sentetik/şartname kayıtları yalnız sayılır.
 *  - Rapor ham başlık/gövde/URL içermez; kayıt kimlikleri hash'lenir.
 *  - İnsan etiketi yoksa çıkış kodu 0'dır ama durum `INSUFFICIENT DATA` olur.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extract } from '../src/extraction/engine';
import { evaluateExtraction, type ExtractionEvalRecord } from '../src/evaluation/extraction';
import { parseJsonOutputArg, writeJsonReport } from '../src/lib/json-output';

function argValue(flag: string): string | null {
  // `--file yol` ve `--file=yol` biçimleri desteklenir. Yalnız ilkini desteklemek,
  // operatörün sessizce varsayılan etiket dosyasını ölçmesine yol açıyordu.
  const inline = process.argv.find((argument) => argument.startsWith(`${flag}=`));
  if (inline !== undefined) {
    const value = inline.slice(flag.length + 1);
    return value.length > 0 ? value : null;
  }
  const indexes = process.argv.flatMap((argument, index) => (argument === flag ? [index] : []));
  if (indexes.length > 1) throw new Error(`${flag} bir kez verilmelidir.`);
  return indexes.length === 1 ? (process.argv[indexes[0]! + 1] ?? null) : null;
}

function resolveCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function pct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function main(): number {
  const file = argValue('--file') ?? join(process.cwd(), 'tests/fixtures/eval/labeled-set.json');
  let parsed: { records?: ExtractionEvalRecord[] };
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as { records?: ExtractionEvalRecord[] };
  } catch (error) {
    console.error(`Etiket dosyası okunamadı: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (!Array.isArray(parsed.records)) {
    console.error('Etiket dosyası geçersiz: records dizisi yok.');
    return 2;
  }

  const report = evaluateExtraction(parsed.records, {
    extractor: extract,
    now: new Date(),
    commit: resolveCommit(),
  });
  const jsonArg = parseJsonOutputArg(process.argv);

  console.log(`Alan çıkarımı değerlendirmesi — ${report.status}`);
  console.log(
    `  Kayıt: toplam ${report.counts.total} · gerçek ${report.counts.real} (insan ${report.counts.realHuman}, ` +
      `ölçülebilir ${report.counts.realScorable}) · sentetik ${report.counts.synthetic} · şartname ${report.counts.specTitle}`,
  );
  console.log(
    `  Ölçülemez: gövdesiz ${report.unscorable.noBody} · kısa gövde ${report.unscorable.shortBody} · ` +
      `alan etiketi yok ${report.unscorable.noExpectedFields} · insan dışı ${report.unscorable.nonHuman}`,
  );
  console.log(
    `  Genel: TP ${report.overall.truePositive} · FP ${report.overall.falsePositive} · FN ${report.overall.falseNegative} · ` +
      `P ${pct(report.overall.precision)} · R ${pct(report.overall.recall)} · F1 ${pct(report.overall.f1)} · ` +
      `makro F1 ${pct(report.overall.macroF1)}`,
  );
  console.log('\nAlanlar:');
  for (const field of report.fields) {
    if (field.ratesSuppressed) {
      console.log(
        `  ${field.key.padEnd(22)} destek ${String(field.support).padStart(3)} · YETERSİZ (en az ${report.config.minFieldSupport})`,
      );
      continue;
    }
    console.log(
      `  ${field.key.padEnd(22)} destek ${String(field.support).padStart(3)} · P ${pct(field.precision)} · R ${pct(field.recall)} · ` +
        `F1 ${pct(field.f1)} · doldurma ${pct(field.fillRate)} · kaçırılan ${field.missed} · uydurma ${field.hallucinated}`,
    );
  }
  console.log(
    `\nKanıt: ${report.evidence.valid}/${report.evidence.checkedFacts} doğrulandı · eksik ${report.evidence.missing} · ` +
      `geçersiz ${report.evidence.invalid} · liste-kaynaklı doğrulanamayan ${report.evidence.listingUnverified}`,
  );
  console.log(
    `Tarih: rol karışması ${report.dateChecks.roleConfusions} · tutarsızlık ${report.dateChecks.consistencyIssues}`,
  );
  console.log(
    `Metadata: evaluator ${report.evaluatorVersion} · extraction ${report.extractionVersion} · commit ${report.commit ?? 'bilinmiyor'} · ` +
      `dataset ${report.datasetHash.slice(0, 16)}… · LLM çağrısı 0 · ağ çağrısı 0`,
  );
  if (report.status === 'INSUFFICIENT DATA') {
    console.log(
      `\nSONUÇ: INSUFFICIENT DATA — en az ${report.config.minRealRecords} ölçülebilir insan doğrulamalı gerçek kayıt gerekir. ` +
        'Bu rapor başarı yüzdesi DEĞİLDİR.',
    );
  }

  const payload = {
    ...report,
    // Dosya yolu kullanıcı adı içerebilir; yalnızca dosya adı raporlanır.
    sourceFile: file.split(/[\\/]/u).pop() ?? 'labeled-set.json',
  };
  if (jsonArg.mode === 'dosya') {
    const written = writeJsonReport(jsonArg.path, payload);
    console.log(written.ok ? `JSON rapor: ${written.path}` : `JSON rapor yazılamadı: ${written.message}`);
    if (!written.ok) return 1;
  } else if (jsonArg.mode === 'stdout') {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  }
  return 0;
}

process.exitCode = main();
