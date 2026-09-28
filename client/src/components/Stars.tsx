const STAR_PATH = 'M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.4l-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9z';

export function StarShape({ size = 18, filled }: { size?: number; filled: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={filled ? 'star star-filled' : 'star'}>
      <path d={STAR_PATH} />
    </svg>
  );
}

/** Read-only rating with fractional fill (e.g. 4.6). Announced as text, never as five images. */
export function Stars({ value, size = 18 }: { value: number; size?: number }) {
  const pct = Math.max(0, Math.min(100, (value / 5) * 100));
  const label = `${Number.isInteger(value) ? value : value.toFixed(1)} out of 5 stars`;
  return (
    <span className="stars" role="img" aria-label={label} style={{ ['--star-size' as string]: `${size}px` }}>
      <span className="stars-row" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <StarShape key={i} size={size} filled={false} />
        ))}
      </span>
      <span className="stars-row stars-fill" aria-hidden="true" style={{ width: `${pct}%` }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <StarShape key={i} size={size} filled />
        ))}
      </span>
    </span>
  );
}
