'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { useTheme } from '@/lib/theme-context';
import { sansFont } from '@/lib/theme';

/** Button + popup dropdown for filtering logs by attack type */
export default function AttackTypeFilter({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 12px',
          borderRadius: 9,
          background: t.surface2,
          border: `1px solid ${t.border}`,
          color: t.text,
          fontSize: 12.5,
          fontWeight: 600,
          cursor: 'pointer',
          ...sansFont,
        }}
      >
        {value}
        <ChevronDown
          size={13}
          color={t.muted}
          style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}
        />
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            minWidth: 200,
            background: t.surface2,
            border: `1px solid ${t.border}`,
            borderRadius: 10,
            boxShadow: '0 10px 28px rgba(0,0,0,0.4)',
            padding: 6,
            zIndex: 20,
            maxHeight: 260,
            overflowY: 'auto',
          }}
        >
          {options.map((opt) => (
            <button
              key={opt}
              onClick={() => {
                onChange(opt);
                setOpen(false);
              }}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                padding: '8px 10px',
                borderRadius: 7,
                background: opt === value ? 'rgba(59,130,246,0.12)' : 'transparent',
                border: 'none',
                color: t.text,
                fontSize: 12.5,
                textAlign: 'left',
                cursor: 'pointer',
                ...sansFont,
              }}
            >
              {opt}
              {opt === value && <Check size={13} color={t.blue2} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
