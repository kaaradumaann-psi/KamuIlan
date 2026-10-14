import { describe, expect, it } from 'vitest';
import { detectNextPage } from '../src/sources/pagination';

const listingUrl = 'https://example.gov.tr/duyurular';

describe('detectNextPage', () => {
  it('follows an explicit next link', () => {
    const html = `<nav class="pagination"><a href="?page=1" aria-current="page">1</a><a href="?page=2" rel="next">Sonraki</a></nav>`;
    expect(detectNextPage(html, listingUrl)).toEqual({
      nextUrl: 'https://example.gov.tr/duyurular?page=2',
      detected: true,
      endConfirmed: false,
    });
  });

  it('uses a visible disabled next control as terminal evidence', () => {
    const current = `${listingUrl}?page=2`;
    const html = `<nav class="pagination">
      <a href="?page=1">1</a><a href="?page=2" class="active" aria-current="page">2</a>
      <a href="?page=3" rel="next" aria-disabled="true" class="disabled">Sonraki</a>
    </nav>`;
    expect(detectNextPage(html, current)).toEqual({ nextUrl: null, detected: true, endConfirmed: true });
  });

  it('does not claim a one-page archive just because an uninformative pager exists', () => {
    const html = `<nav class="pagination"><a href="?page=1" class="active" aria-current="page">1</a></nav>`;
    expect(detectNextPage(html, listingUrl)).toEqual({ nextUrl: null, detected: true, endConfirmed: false });
  });

  it('does not mistake a content link for the pager next link when a pager exists', () => {
    const html = `<nav class="pagination"><a href="?page=1" aria-current="page">1</a></nav>
      <main><a href="?page=2">Ayrıntı sayfası</a></main>`;
    expect(detectNextPage(html, listingUrl)).toEqual({ nextUrl: null, detected: true, endConfirmed: false });
  });

  it('does not call a visible active page the final page without a terminal marker', () => {
    const current = `${listingUrl}?page=2`;
    const html = `<nav class="pagination"><a href="?page=2" aria-current="page">2</a></nav>`;
    expect(detectNextPage(html, current)).toEqual({ nextUrl: null, detected: true, endConfirmed: false });
  });

  it('keeps coverage unknown when there is no next link or explicit last-page marker', () => {
    const html = `<main><a href="/duyuru/personel-alimi">Sözleşmeli personel ilanı</a></main>`;
    expect(detectNextPage(html, listingUrl)).toEqual({ nextUrl: null, detected: false, endConfirmed: false });
  });

  it('ignores links that leave the source host', () => {
    const html = `<nav class="pagination"><a rel="next" href="https://other.gov.tr/duyurular?page=2">Sonraki</a></nav>`;
    expect(detectNextPage(html, listingUrl)).toEqual({ nextUrl: null, detected: true, endConfirmed: false });
  });
});
