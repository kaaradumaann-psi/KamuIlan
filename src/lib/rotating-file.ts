/**
 * Boyuta göre döndürülen JSON satır log dosyası (bağımlılıksız).
 *
 * Neden: loglar yalnız standart çıktıya gidiyordu; süreç yöneticisi yapılandırılmamışsa her yeniden
 * başlatmada kayboluyordu ve teknik olmayan operatör (ya da Claude Code) inceleyebileceği bir dosya
 * bulamıyordu. `LOG_FILE` verilirse satırlar ayrıca bu dosyaya yazılır.
 *
 * Kurallar:
 *  - Yazım SENKRON (`appendFileSync`): süreç çökse de yazılan satır diskte kalır; hacim düşüktür.
 *  - Dosya `maxBytes`'ı aşacaksa döndürülür: `api.log` → `api.log.1` → … → `api.log.<maxFiles>` (en
 *    eskisi silinir). Disk kullanımı en fazla ~ maxBytes × (maxFiles + 1).
 *  - Her süreç KENDİ dosyasını kullanmalı (API ve worker ayrı `LOG_FILE`); aynı dosyaya iki süreç
 *    yazarsa döndürme yarışır.
 *  - Disk hatası uygulamayı durdurmaz: dosyaya yazılamazsa satır yalnız standart çıktıya gider ve
 *    bir kez standart hataya not düşülür.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface RotatingFileOptions {
  maxBytes: number;
  maxFiles: number;
}

export class RotatingFileStream {
  private size: number;
  private failed = false;

  constructor(
    readonly path: string,
    private readonly options: RotatingFileOptions,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.size = existsSync(path) ? statSync(path).size : 0;
  }

  write(line: string): void {
    const bytes = Buffer.byteLength(line);
    try {
      if (this.size > 0 && this.size + bytes > this.options.maxBytes) this.rotate();
      appendFileSync(this.path, line, { mode: 0o640 });
      this.size += bytes;
    } catch (error) {
      if (!this.failed) {
        this.failed = true;
        process.stderr.write(`[log] ${this.path} dosyasına yazılamadı: ${(error as Error).message}\n`);
      }
    }
  }

  private rotate(): void {
    const { maxFiles } = this.options;
    const oldest = `${this.path}.${maxFiles}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let index = maxFiles - 1; index >= 1; index -= 1) {
      const from = `${this.path}.${index}`;
      if (existsSync(from)) renameSync(from, `${this.path}.${index + 1}`);
    }
    if (maxFiles >= 1) renameSync(this.path, `${this.path}.1`);
    else unlinkSync(this.path);
    this.size = 0;
  }
}

const streams = new Map<string, RotatingFileStream>();

/** Süreç başına tek akış (aynı dosyaya birden çok logger yazar; döndürme tek yerden yönetilir). */
export function rotatingFileStream(path: string, options: RotatingFileOptions): RotatingFileStream {
  const key = resolve(path);
  let stream = streams.get(key);
  if (!stream) {
    stream = new RotatingFileStream(key, options);
    streams.set(key, stream);
  }
  return stream;
}
