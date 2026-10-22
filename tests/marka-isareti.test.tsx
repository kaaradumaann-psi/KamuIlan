/**
 * Marka işareti = favicon.
 *
 * Giriş ekranı, üst çubuk, yan menü ve alt bilgi `BrandMark` bileşenini kullanır;
 * tarayıcı sekmesi `public/favicon.svg`'yi. İkisi aynı çizimi (aynı şekiller,
 * aynı renkler) taşımalıdır; biri değişip diğeri unutulursa bu test kırılır.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BrandMark } from '../src/components/BrandMark';

const ROOT = resolve(__dirname, '..');

/** SVG'deki çizim öğelerini (etiket + geometri + renk) sıralı imzaya çevirir. */
function shapes(svg: string): string[] {
  return [...svg.matchAll(/<(rect|circle|path)\b([^>]*)\/?>/g)].map(([, tag, attrs]) => {
    const pick = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs ?? '')?.[1] ?? '';
    return [tag, pick('width'), pick('rx'), pick('cx'), pick('cy'), pick('r'), pick('d'), pick('fill'), pick('stroke')]
      .join('|')
      .toLowerCase();
  });
}

describe('marka işareti', () => {
  it('BrandMark ile favicon.svg aynı çizimdir', () => {
    const favicon = readFileSync(join(ROOT, 'public/favicon.svg'), 'utf8');
    const component = renderToStaticMarkup(<BrandMark size={44} />);
    expect(shapes(favicon).length).toBeGreaterThan(0);
    expect(shapes(component)).toEqual(shapes(favicon));
  });

  it('index.html SVG ve PNG simgelerini aynı sürümle bağlar', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    expect(html).toMatch(/rel="icon" type="image\/svg\+xml" href="\/favicon\.svg\?v=\d+"/);
    expect(html).toMatch(/rel="icon" type="image\/png" sizes="32x32" href="\/favicon-32\.png\?v=\d+"/);
    expect(html).toMatch(/rel="apple-touch-icon"/);
    for (const file of ['favicon-32.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png']) {
      expect(readFileSync(join(ROOT, 'public', file)).subarray(1, 4).toString()).toBe('PNG');
    }
  });
});
