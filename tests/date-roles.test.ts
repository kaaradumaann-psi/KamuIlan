/**
 * Tarih rolleri: sınav tarihi, yayım tarihi ve son başvuru birbirine karışmaz.
 * Başvuru cümlesi olmayan tarih son başvuru olarak atanmaz.
 */
import { describe, expect, it } from 'vitest';
import { extractApplicationWindow } from '../src/extraction/engine';

describe('tarih rolleri', () => {
  it('sınav tarihi son başvuru tarihi olarak alınmaz', () => {
    const result = extractApplicationWindow(
      'Sözleşmeli Personel Alım İlanı',
      'Başvurular 01.10.2026 - 30.10.2026 tarihleri arasında alınacaktır. Yazılı sınav 15.11.2026 tarihinde yapılacaktır.',
    );
    expect(result.end?.dateOnly).toBe('2026-10-30');
  });

  it('başvuru cümlesi olmayan tek tarih son başvuru olarak atanmaz', () => {
    const result = extractApplicationWindow(
      'Kurum Duyurusu',
      'Kurul toplantısı 12.11.2026 tarihinde yapılacaktır. Ayrıntılar kurum sitesinde.',
    );
    expect(result.end).toBeNull();
    expect(result.start).toBeNull();
  });

  it('"son başvuru tarihi" ifadesinin tarihi son başvurudur', () => {
    const result = extractApplicationWindow(
      'Memur Alım İlanı',
      'Son başvuru tarihi 20.10.2026 olup başvurular e-Devlet üzerinden yapılacaktır.',
    );
    expect(result.end?.dateOnly).toBe('2026-10-20');
  });
});
