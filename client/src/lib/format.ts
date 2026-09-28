const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const intf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${intf.format(bytes)} B`;
  if (bytes < 1024 * 1024) return `${nf.format(bytes / 1024)} KB`;
  return `${nf.format(bytes / 1024 / 1024)} MB`;
}

export function formatDimensions(width: number, height: number): string {
  return `${intf.format(width)} × ${intf.format(height)}`;
}

/** "−42%" / "+8%" relative change, with a real minus sign for screen readers and typography. */
export function formatDelta(before: number, after: number): string {
  if (before <= 0) return '';
  const pct = Math.round(((after - before) / before) * 100);
  if (pct === 0) return '±0%';
  return pct < 0 ? `−${Math.abs(pct)}%` : `+${pct}%`;
}

export function formatMegapixels(width: number, height: number): string {
  return `${nf.format((width * height) / 1_000_000)} MP`;
}

export type SizeUnit = 'KB' | 'MB';
export const toBytes = (value: number, unit: SizeUnit) => Math.round(value * (unit === 'MB' ? 1024 * 1024 : 1024));
