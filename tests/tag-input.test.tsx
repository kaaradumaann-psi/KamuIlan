// @vitest-environment jsdom
/**
 * TagInput: seçilebilir çok değerli giriş. Enter/virgül ekler, "×" kaldırır,
 * listede olmayan serbest metin de kabul edilir, boş alanda Backspace son
 * etiketi siler, yinelenen ve çok kısa değerler eklenmez.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { TagInput } from '../src/components/TagInput';

afterEach(cleanup);

function Harness({ initial = [] as string[] }: { initial?: string[] }) {
  const [values, setValues] = useState<string[]>(initial);
  return (
    <TagInput
      id="t"
      ariaLabel="Değerler"
      values={values}
      onChange={setValues}
      suggestions={['Hemşire', 'Psikolog']}
      placeholder="yaz"
    />
  );
}

function field(): HTMLInputElement {
  return screen.getByLabelText('Değerler') as HTMLInputElement;
}

describe('TagInput', () => {
  it('Enter ile etiket ekler ve girişi temizler', () => {
    render(<Harness />);
    fireEvent.change(field(), { target: { value: 'Hemşire' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(screen.getByText('Hemşire')).toBeTruthy();
    expect(field().value).toBe('');
  });

  it('virgül ile etiket ekler', () => {
    render(<Harness />);
    fireEvent.change(field(), { target: { value: 'Zabıta' } });
    fireEvent.keyDown(field(), { key: ',' });
    expect(screen.getByText('Zabıta')).toBeTruthy();
  });

  it('listede olmayan serbest metni kabul eder', () => {
    render(<Harness />);
    fireEvent.change(field(), { target: { value: 'Kütüphane Memuru X' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(screen.getByText('Kütüphane Memuru X')).toBeTruthy();
  });

  it('× düğmesiyle etiketi kaldırır', () => {
    render(<Harness initial={['Hemşire', 'Psikolog']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hemşire değerini kaldır' }));
    expect(screen.queryByText('Hemşire')).toBeNull();
    expect(screen.getByText('Psikolog')).toBeTruthy();
  });

  it('boş alanda Backspace son etiketi siler', () => {
    render(<Harness initial={['Hemşire', 'Psikolog']} />);
    fireEvent.keyDown(field(), { key: 'Backspace' });
    expect(screen.queryByText('Psikolog')).toBeNull();
    expect(screen.getByText('Hemşire')).toBeTruthy();
  });

  it('yinelenen değeri (büyük/küçük harf duyarsız) eklemez', () => {
    render(<Harness initial={['Hemşire']} />);
    fireEvent.change(field(), { target: { value: 'hemşire' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(screen.getAllByText(/hemşire/i).length).toBe(1);
  });

  it('2 karakterden kısa değeri eklemez', () => {
    const onChange = vi.fn();
    render(<TagInput id="t" ariaLabel="Değerler" values={[]} onChange={onChange} />);
    fireEvent.change(field(), { target: { value: 'a' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('blur ile bekleyen metni ekler (datalist seçimi kaybolmaz)', () => {
    render(<Harness />);
    fireEvent.change(field(), { target: { value: 'Psikolog' } });
    fireEvent.blur(field());
    expect(screen.getByText('Psikolog')).toBeTruthy();
  });
});
