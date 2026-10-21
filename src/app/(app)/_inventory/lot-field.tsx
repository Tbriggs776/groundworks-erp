"use client";

import { lotLabel, type LotChoice } from "./purchase-items";

const cell = "w-full text-xs bg-background border border-border rounded-md px-2 py-1.5";

/**
 * The lot on a line (specific identification). Stock going out or coming
 * back picks a lot that exists; stock coming in types one (new or
 * existing) and can give a new lot its expiration date.
 */
export function LotField({
  lots,
  itemId,
  value,
  onChange,
  incoming = false,
  expiresOn,
  onExpiresOn,
}: {
  lots: LotChoice[];
  itemId: string;
  value: string;
  onChange: (lotNumber: string) => void;
  incoming?: boolean;
  expiresOn?: string;
  onExpiresOn?: (date: string) => void;
}) {
  const mine = lots.filter((l) => l.itemId === itemId);
  if (!incoming) {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} className={cell} aria-label="Lot">
        <option value="">Lot…</option>
        {mine.map((l) => (
          <option key={l.lotNumber} value={l.lotNumber}>
            {lotLabel(l)}
          </option>
        ))}
      </select>
    );
  }
  const listId = `lots-${itemId}`;
  const known = mine.some((l) => l.lotNumber === value);
  return (
    <div className="space-y-1">
      <input list={listId} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Lot number" aria-label="Lot" className={cell} />
      <datalist id={listId}>
        {mine.map((l) => (
          <option key={l.lotNumber} value={l.lotNumber}>
            {lotLabel(l)}
          </option>
        ))}
      </datalist>
      {onExpiresOn && value && !known && (
        <input type="date" value={expiresOn ?? ""} onChange={(e) => onExpiresOn(e.target.value)} aria-label="Lot expires" title="Expires (optional)" className={cell} />
      )}
    </div>
  );
}
