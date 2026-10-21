/**
 * Sorgu motoru: `$exists` semantiği.
 *
 * Bulgu (21.10.2026): `matchValue()` yalnızca "alan yok" durumunu ele alıyordu;
 * `{ applicationUrl: { $exists: false } }` koşulu **değeri olan** belgeleri de
 * eşliyordu. Bu yüzden `$or: [{ applicationUrl: null }, { applicationUrl: { $exists: false } }]`
 * ile kurulan "başvuru bağlantısı belirtilmemiş" filtresi hiçbir şeyi elemiyordu.
 * Aynı kod yolu dosya, MongoDB ve Postgres sürücülerinde ortaktır (nihai karar
 * her zaman `matchesQuery`/`sortDocuments` içinden gelir).
 */
import { describe, expect, it } from 'vitest';
import { matchesQuery, type Query } from '../src/db/query';

type Doc = { id: string; applicationUrl?: string | null; note?: string };

const DOCS: Doc[] = [
  { id: 'with-url', applicationUrl: 'https://basvuru.test/1' },
  { id: 'null-url', applicationUrl: null },
  { id: 'missing-url' },
];

function ids(query: Query): string[] {
  return DOCS.filter((doc) => matchesQuery(doc, query)).map((doc) => doc.id);
}

describe('$exists', () => {
  it('$exists:false yalnızca alanı OLMAYAN belgeleri getirir', () => {
    expect(ids({ applicationUrl: { $exists: false } })).toEqual(['missing-url']);
  });

  it('$exists:true alanı olan belgeleri getirir (null değeri de "var" sayılır)', () => {
    expect(ids({ applicationUrl: { $exists: true } })).toEqual(['with-url', 'null-url']);
  });

  it('"bağlantı belirtilmemiş" filtresi değeri olan ilanı eler', () => {
    const query: Query = {
      $or: [{ applicationUrl: null }, { applicationUrl: { $exists: false } }],
    };
    expect(ids(query)).toEqual(['null-url', 'missing-url']);
  });

  it('$and içindeki $or dalı aynı sonucu verir', () => {
    const query: Query = {
      $and: [{ id: { $ne: 'null-url' } }, { $or: [{ applicationUrl: null }, { applicationUrl: { $exists: false } }] }],
    };
    expect(ids(query)).toEqual(['missing-url']);
  });
});
