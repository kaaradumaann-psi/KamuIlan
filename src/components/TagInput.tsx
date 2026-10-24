/**
 * Çok değerli, seçilebilir metin girişi (etiket/chip listesi).
 *
 * Kullanıcı ya listeden (datalist önerileri) seçer ya da serbestçe yazar.
 * Enter veya virgül yeni bir etiket ekler; her etiket "×" ile kaldırılır.
 * Değer her zaman `string[]`'tir — Panel'deki eski virgüllü metin alanlarının
 * yerini alır (yazarken veri kaybı olmaz, ham taslak tutmaya gerek kalmaz).
 *
 * Erişilebilirlik: alan `role="group"` içinde etiketlenir, her kaldırma
 * düğmesinin `aria-label`'ı değeri söyler, boş alanda Backspace son etiketi
 * siler. Öneriler yerel `<datalist>` ile sunulur; seçim serbest metni engellemez.
 */
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from './Icon';

export interface TagInputProps {
  /** Alanın görünür etiketini bağlamak için `<label htmlFor>` değeri. */
  id: string;
  values: string[];
  onChange: (values: string[]) => void;
  /** Otomatik tamamlama önerileri (seçim zorunlu değildir). */
  suggestions?: readonly string[];
  placeholder?: string;
  /** Eklenebilecek en kısa değer (sunucu şeması en az 2 karakter ister). */
  minLength?: number;
  /** Her bir değerin en fazla uzunluğu. */
  maxLength?: number;
  /** Girdi kutusu için ekran okuyucu etiketi (görünür label'a ek olarak). */
  ariaLabel?: string;
  disabled?: boolean;
}

/** Baştaki/sondaki boşlukları kırpar ve çok değerli girişi tek değere indirger. */
function clean(value: string): string {
  return value.trim();
}

export function TagInput({
  id,
  values,
  onChange,
  suggestions,
  placeholder,
  minLength = 2,
  maxLength = 80,
  ariaLabel,
  disabled = false,
}: TagInputProps): ReactNode {
  const [draft, setDraft] = useState('');
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = (raw: string): void => {
    const next = clean(raw).slice(0, maxLength);
    if (next.length < minLength) return;
    // Büyük/küçük harf duyarsız yinelenme engeli (Türkçe locale).
    const exists = values.some((item) => item.toLocaleLowerCase('tr') === next.toLocaleLowerCase('tr'));
    if (!exists) onChange([...values, next]);
    setDraft('');
  };

  const removeAt = (index: number): void => {
    onChange(values.filter((_, position) => position !== index));
    inputRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commit(draft);
    } else if (event.key === 'Backspace' && draft.length === 0 && values.length > 0) {
      event.preventDefault();
      removeAt(values.length - 1);
    }
  };

  return (
    <div className={`tag-input${disabled ? ' is-disabled' : ''}`} role="group">
      {values.map((value, index) => (
        <span className="tag-chip" key={`${value}-${index}`}>
          <span className="tag-chip-label">{value}</span>
          <button
            type="button"
            className="tag-chip-remove"
            aria-label={`${value} değerini kaldır`}
            onClick={() => removeAt(index)}
            disabled={disabled}
          >
            <Icon name="close" size={12} />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        id={id}
        className="tag-input-field"
        type="text"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => commit(draft)}
        placeholder={values.length === 0 ? placeholder : ''}
        aria-label={ariaLabel}
        list={suggestions && suggestions.length > 0 ? listId : undefined}
        maxLength={maxLength}
        disabled={disabled}
        autoComplete="off"
      />
      {suggestions && suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.map((option) => (
            <option value={option} key={option} />
          ))}
        </datalist>
      )}
    </div>
  );
}
