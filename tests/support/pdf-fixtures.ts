/**
 * Asgari PDF üreticisi — yalnızca test ve fixture amaçlı.
 *
 * Neden kendi üreticimiz: PDF testlerinin GERÇEK bir metin katmanına karşı
 * koşması gerekiyor; bu ortamda LaTeX/LibreOffice/tarayıcı yok. Üretilen dosya
 * geçerli bir PDF 1.4'tür: Katalog → Sayfa → içerik akışı + xref tablosu.
 *
 * KISIT (bilinçli): gömülü yazı tipi yoktur (Helvetica/WinAnsiEncoding), bu
 * yüzden Türkçe aksanlı harfler ASCII karşılıklarına çevrilir. Bu, "PDF metin
 * katmanı okunuyor mu?" sorusunu ölçmek için yeterlidir; aksanlı harflerin
 * çözümü pdfjs'in ToUnicode haritasına bağlıdır ve ayrı bir konudur.
 */

const ASCII_FOLD: Record<string, string> = {
  ç: 'c',
  Ç: 'C',
  ğ: 'g',
  Ğ: 'G',
  ı: 'i',
  İ: 'I',
  ö: 'o',
  Ö: 'O',
  ş: 's',
  Ş: 'S',
  ü: 'u',
  Ü: 'U',
  â: 'a',
  Â: 'A',
  î: 'i',
  Î: 'I',
  û: 'u',
  Û: 'U',
  '’': "'",
  '‘': "'",
  '“': '"',
  '”': '"',
  '–': '-',
  '—': '-',
  '…': '...',
  '\u00A0': ' ',
};

/** PDF metin akışı yalnızca ASCII/WinAnsi taşıyabilir; aksanlar sadeleştirilir. */
export function asciiFold(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, (char) => ASCII_FOLD[char] ?? '?');
}

function escapePdfText(value: string): string {
  return asciiFold(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

interface PdfBuildOptions {
  /** Belge başlığı (/Info sözlüğü) — ASCII'ye sadeleştirilir. */
  title?: string;
  /** Sayfaya çizilecek metin satırları. Boş dizi → metin katmanı yok. */
  lines?: readonly string[];
}

/**
 * Tek sayfalık PDF üretir. `lines` boşsa sayfada yalnızca bir dikdörtgen çizilir
 * (taranmış ilan PDF'lerini taklit eder: metin katmanı yoktur).
 */
export function buildPdf(options: PdfBuildOptions = {}): Buffer {
  const lines = options.lines ?? [];
  const content =
    lines.length === 0
      ? '0.95 0.95 0.95 rg\n20 20 555 802 re f\n'
      : [
          'BT',
          '/F1 11 Tf',
          '14 TL',
          '50 790 Td',
          ...lines.map((line) => `(${escapePdfText(line)}) Tj T*`),
          'ET',
        ].join('\n');

  const contentBuffer = Buffer.from(`${content}\n`, 'latin1');
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];

  const chunks: Buffer[] = [];
  let offset = 0;
  const push = (value: Buffer | string): void => {
    const buffer = typeof value === 'string' ? Buffer.from(value, 'latin1') : value;
    chunks.push(buffer);
    offset += buffer.byteLength;
  };

  // Başlık + ikili olduğunu belirten yorum satırı (PDF standardı önerisi).
  push('%PDF-1.4\n');
  push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(offset);
    push(`${index + 1} 0 obj\n${body}\nendobj\n`);
  });

  // İçerik akışı (5. nesne)
  offsets.push(offset);
  push(`5 0 obj\n<< /Length ${contentBuffer.byteLength} >>\nstream\n`);
  push(contentBuffer);
  push('endstream\nendobj\n');

  let infoObjectNumber = 0;
  if (options.title) {
    infoObjectNumber = 6;
    offsets.push(offset);
    push(`6 0 obj\n<< /Title (${escapePdfText(options.title)}) /Producer (KamuRadar test fixture) >>\nendobj\n`);
  }

  const totalObjects = infoObjectNumber === 0 ? 5 : 6;
  const xrefOffset = offset;

  const xrefLines = ['xref', `0 ${totalObjects + 1}`, '0000000000 65535 f '];
  for (let index = 0; index < totalObjects; index += 1) {
    const objectOffset = offsets[index] ?? 0;
    xrefLines.push(`${objectOffset.toString().padStart(10, '0')} 00000 n `);
  }
  push(`${xrefLines.join('\n')}\n`);

  const trailer = infoObjectNumber
    ? `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R /Info ${infoObjectNumber} 0 R >>\n`
    : `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\n`;
  push(trailer);
  push(`startxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

/** Metin katmanı olan örnek ilan PDF'i (fixture ile aynı içerik). */
export function sampleAnnouncementPdf(): Buffer {
  return buildPdf({
    title: 'Ornek Universitesi Sozlesmeli Personel Alim Ilani',
    lines: [
      'ORNEK UNIVERSITESI REKTORLUGUNDEN',
      'SOZLESMELI PERSONEL ALIM ILANI',
      '',
      'Universitemiz birimlerinde istihdam edilmek uzere 657 sayili Devlet',
      'Memurlari Kanunu 4/B maddesi kapsaminda sozlesmeli personel alinacaktir.',
      '',
      'Kontenjan: 25 kisi (Hemsire, Saglik Teknikeri)',
      'Basvuru baslangici: 20.10.2026 09:00',
      'Basvuru bitisi: 30.10.2026 23:59',
      'KPSS taban puani: 70 (P3)',
      'Basvurular Kariyer Kapisi uzerinden elektronik ortamda yapilacaktir.',
    ],
  });
}

/** Metin katmanı OLMAYAN (taranmış görüntü benzeri) PDF. */
export function scannedAnnouncementPdf(): Buffer {
  return buildPdf({ title: 'Taranmis Ilan', lines: [] });
}

/** Başlığı doğru ama gövdesi bozuk PDF: çökmemeli, hata döndürmeli. */
export function corruptPdf(): Buffer {
  return Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 99 0 R >>\nendobj\nstartxref\n999\n%%EOF\n', 'latin1');
}
