import { useState } from 'react';
import { MODEL_CHOICES, modelLabel, modelPriceLabel, resolveModelName } from './llm/models';

/**
 * Pick a model, or leave the default — a dropdown, each model with its price
 * per million tokens. `value` is the model as written ('' = the default); an
 * id not in the list shows under "Other…" as typed. Used by the phase forms
 * (`model`) and the agent editor (`model:` frontmatter). The native build
 * uses ModelPicker.tsx.
 */
export function ModelPicker({
  value,
  onChange,
  defaultModel,
  defaultSource,
}: {
  value: string;
  onChange: (next: string) => void;
  /** The model "Default" runs on here, and where that comes from. */
  defaultModel: string;
  defaultSource: string;
}) {
  const listed = MODEL_CHOICES.some(c => c.id === value);
  const [other, setOther] = useState(!!value && !listed);
  const selected = other ? '__other' : value || '__default';
  const effective = resolveModelName(value) ?? defaultModel;
  const price = modelPriceLabel(effective);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <select
        aria-label="Model"
        value={selected}
        onChange={e => {
          const v = e.target.value;
          if (v === '__other') {
            setOther(true);
            if (listed) onChange('');
          } else {
            setOther(false);
            onChange(v === '__default' ? '' : v);
          }
        }}
        style={selectStyle}>
        <option value="__default">
          Default — {modelLabel(defaultModel)} ({defaultSource})
        </option>
        {MODEL_CHOICES.map(c => {
          const p = modelPriceLabel(c.id);
          return (
            <option key={c.id} value={c.id}>
              {c.label}
              {p ? ` — ${p}` : ''}
            </option>
          );
        })}
        <option value="__other">Other…</option>
      </select>
      {other ? (
        <input
          type="text"
          aria-label="Model id"
          value={value}
          onChange={e => onChange(e.target.value.trim())}
          placeholder="a model id, e.g. claude-opus-4-1, or an alias: opus / sonnet / haiku"
          autoCapitalize="none"
          autoCorrect="off"
          style={inputStyle}
        />
      ) : null}
      <span style={hintStyle}>
        Runs on {effective || '…'}
        {price ? ` · ${price}` : effective ? ' · no price on file' : ''}
      </span>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  padding: '6px 8px',
  borderRadius: 6,
  border: '1px solid #d1d5db',
  background: '#ffffff',
  color: '#111827',
  fontSize: 12,
  maxWidth: '100%',
};
const inputStyle: React.CSSProperties = { ...selectStyle, padding: '6px 10px' };
const hintStyle: React.CSSProperties = { fontSize: 11, color: '#6b7280' };
