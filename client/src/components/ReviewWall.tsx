import { useEffect, useMemo, useState } from 'react';
import { getPublicFeedback, relativeTime, type PublicFeedback, type ReviewItem } from '../lib/feedbackApi';
import { FeedbackForm, FeedbackThanks } from './FeedbackForm';
import { Stars } from './Stars';

/** Minimum cards per loop half, so short lists still fill wide screens. */
const MIN_CARDS = 8;
const SECONDS_PER_CARD = 7;

function ReviewCard({ item }: { item: ReviewItem }) {
  return (
    <figure className="review-card">
      <Stars value={item.rating} size={15} />
      <blockquote className="review-text">{item.comment}</blockquote>
      <figcaption className="review-meta">
        <span className="review-name">{item.name || 'Anonymous'}</span>
        <span aria-hidden="true"> · </span>
        <time dateTime={item.createdAt}>{relativeTime(item.createdAt)}</time>
      </figcaption>
    </figure>
  );
}

function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(query);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/** Reduced motion: nothing moves; reviews become a keyboard-scrollable row. */
function StaticRow({ items }: { items: ReviewItem[] }) {
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scrollable regions must be keyboard reachable (WCAG 2.1.1)
    <div className="reviews-scroll" tabIndex={0} role="region" aria-label="Recent reviews, scrollable">
      <ul className="marquee-group">
        {items.map((item) => (
          <li key={item.id}>
            <ReviewCard item={item} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Marquee({ items }: { items: ReviewItem[] }) {
  const [paused, setPaused] = useState(false);
  const reduced = useReducedMotion();
  // Repeat short lists to fill the track, then render it twice for a seamless loop.
  const loop = useMemo(() => {
    const out: ReviewItem[] = [];
    while (out.length < Math.max(MIN_CARDS, items.length)) out.push(...items);
    return out;
  }, [items]);

  if (reduced) return <StaticRow items={items} />;

  return (
    <div className="marquee" data-paused={paused}>
      <div className="marquee-controls">
        <button type="button" className="btn btn-sm" aria-pressed={paused} onClick={() => setPaused((p) => !p)}>
          {paused ? 'Play reviews' : 'Pause reviews'}
        </button>
      </div>
      <div className="marquee-viewport">
        <div className="marquee-track" style={{ ['--marquee-duration' as string]: `${loop.length * SECONDS_PER_CARD}s` }}>
          {/* First copy: the real, accessible list (each review once). */}
          <ul className="marquee-group" aria-label="Recent reviews">
            {loop.map((item, i) =>
              i < items.length ? (
                <li key={`a-${i}`}>
                  <ReviewCard item={item} />
                </li>
              ) : (
                <li key={`a-${i}`} aria-hidden="true">
                  <ReviewCard item={item} />
                </li>
              ),
            )}
          </ul>
          {/* Second copy: purely visual, completes the loop. */}
          <ul className="marquee-group" aria-hidden="true">
            {loop.map((item, i) => (
              <li key={`b-${i}`}>
                <ReviewCard item={item} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

export function ReviewWall({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<PublicFeedback | null>(null);
  const [writing, setWriting] = useState(false);
  const [sent, setSent] = useState<null | 'published' | 'pending' | 'hidden'>(null);
  const [localRefresh, setLocalRefresh] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    getPublicFeedback(ac.signal).then(setData, () => {
      /* The wall is optional content: on failure it simply isn't shown. */
    });
    return () => ac.abort();
  }, [refreshKey, localRefresh]);

  if (!data?.enabled) return null;
  const { summary, items } = data;

  return (
    <section className="reviews" aria-labelledby="reviews-title">
      <div className="reviews-head">
        <div>
          <p className="eyebrow">Reviews</p>
          <h2 id="reviews-title" className="reviews-title">
            What people are saying
          </h2>
        </div>
        {summary.count > 0 ? (
          <div className="reviews-score">
            <span className="reviews-average num" aria-hidden="true">
              {summary.average.toFixed(1)}
            </span>
            <div>
              <Stars value={summary.average} size={18} />
              <p className="field-hint num">
                {summary.count.toLocaleString()} {summary.count === 1 ? 'rating' : 'ratings'}
              </p>
            </div>
          </div>
        ) : null}
        {!writing && !sent ? (
          <button type="button" className="btn" onClick={() => setWriting(true)}>
            Leave feedback
          </button>
        ) : null}
      </div>

      {writing ? (
        <div className="card reviews-form">
          <h3 className="feedback-title">Share your experience</h3>
          <FeedbackForm
            cancelLabel="Cancel"
            onCancel={() => setWriting(false)}
            onDone={(status) => {
              setWriting(false);
              setSent(status);
              setLocalRefresh((n) => n + 1);
            }}
          />
        </div>
      ) : null}
      {sent ? <FeedbackThanks status={sent} /> : null}

      {items.length > 0 ? (
        <Marquee items={items} />
      ) : (
        <p className="reviews-empty">
          {summary.count > 0 ? 'No written reviews yet — be the first to leave a comment.' : 'No reviews yet — be the first to share your experience.'}
        </p>
      )}
    </section>
  );
}
