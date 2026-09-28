import { useId, useState, type FormEvent } from 'react';
import { ApiError } from '../lib/api';
import { RATING_LABELS, submitFeedback, type FeedbackStatus } from '../lib/feedbackApi';
import { CheckIcon } from './icons';
import { StarShape } from './Stars';
import { ErrorAlert } from './ui';

const COMMENT_MAX = 500;
const NAME_MAX = 40;

/** Hover preview is pure CSS (see .star-picker-row in app.css); selection is native radios. */
function StarPicker({ value, onChange, invalid, describedBy }: { value: number; onChange: (v: number) => void; invalid: boolean; describedBy?: string }) {
  const name = useId();
  return (
    <fieldset className="star-picker" aria-describedby={describedBy} aria-invalid={invalid || undefined}>
      <legend className="field-label">
        Your rating <span className="required-mark" aria-hidden="true">*</span>
        <span className="visually-hidden"> (required)</span>
      </legend>
      <div className="star-picker-row">
        {[1, 2, 3, 4, 5].map((n) => (
          <label key={n} className="star-option">
            <input type="radio" name={name} value={n} checked={value === n} onChange={() => onChange(n)} />
            <StarShape size={30} filled={n <= value} />
            <span className="visually-hidden">
              {n} {n === 1 ? 'star' : 'stars'}, {RATING_LABELS[n]}
            </span>
          </label>
        ))}
        <span className="star-picker-label" aria-hidden="true">
          {value ? RATING_LABELS[value] : ''}
        </span>
      </div>
    </fieldset>
  );
}

interface FeedbackFormProps {
  onDone: (status: FeedbackStatus) => void;
  onCancel?: () => void;
  cancelLabel?: string;
}

/** Rating (required) + optional comment and name, with an invisible honeypot for bots. */
export function FeedbackForm({ onDone, onCancel, cancelLabel = 'Not now' }: FeedbackFormProps) {
  const id = useId();
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const [missingRating, setMissingRating] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!rating) {
      setMissingRating(true);
      document.getElementById(`${id}-stars`)?.querySelector('input')?.focus();
      return;
    }
    setSending(true);
    setError(null);
    try {
      const res = await submitFeedback({ rating, comment, name, website });
      onDone(res.status);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError('Something went wrong. Please try again.', 0, 'unknown'));
    } finally {
      setSending(false);
    }
  };

  return (
    <form className="feedback-form" onSubmit={submit} noValidate>
      <div id={`${id}-stars`}>
        <StarPicker
          value={rating}
          onChange={(v) => {
            setRating(v);
            setMissingRating(false);
          }}
          invalid={missingRating}
          describedBy={missingRating ? `${id}-rating-error` : undefined}
        />
        {missingRating ? (
          <p id={`${id}-rating-error`} className="field-error" role="alert">
            Please choose a rating from 1 to 5 stars.
          </p>
        ) : null}
      </div>

      <div className="field">
        <label className="field-label" htmlFor={`${id}-comment`}>
          Tell us more <span className="field-optional">(optional)</span>
        </label>
        <textarea
          id={`${id}-comment`}
          className="input textarea"
          rows={3}
          maxLength={COMMENT_MAX}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="What worked well? What could be better?"
          aria-describedby={`${id}-comment-count`}
        />
        <p id={`${id}-comment-count`} className="field-hint num" aria-live="polite">
          {comment.length > COMMENT_MAX - 50 ? `${COMMENT_MAX - comment.length} characters left` : `Up to ${COMMENT_MAX} characters`}
        </p>
      </div>

      <div className="field">
        <label className="field-label" htmlFor={`${id}-name`}>
          Your name <span className="field-optional">(optional)</span>
        </label>
        <input
          id={`${id}-name`}
          className="input"
          type="text"
          autoComplete="given-name"
          maxLength={NAME_MAX}
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-describedby={`${id}-name-hint`}
        />
        <p id={`${id}-name-hint`} className="field-hint">
          Shown with your review. Leave blank to post anonymously.
        </p>
      </div>

      {/* Honeypot: hidden from people and assistive technology; bots fill it in. */}
      <div className="hp-field" aria-hidden="true">
        <label htmlFor={`${id}-website`}>Website</label>
        <input id={`${id}-website`} type="text" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
      </div>

      <p className="field-hint">Your rating and comment may be shown publicly on this site. Please don’t include personal details.</p>

      {error ? <ErrorAlert title={error.message} /> : null}

      <div className="feedback-actions">
        <button type="submit" className="btn btn-primary" disabled={sending}>
          {sending ? <span className="spinner" aria-hidden="true" /> : null}
          {sending ? 'Sending…' : 'Send feedback'}
        </button>
        {onCancel ? (
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={sending}>
            {cancelLabel}
          </button>
        ) : null}
      </div>
    </form>
  );
}

export function FeedbackThanks({ status }: { status: FeedbackStatus }) {
  return (
    <div className="feedback-thanks" role="status">
      <span className="feedback-thanks-icon" aria-hidden="true">
        <CheckIcon size={20} />
      </span>
      <div>
        <p className="feedback-thanks-title">Thank you for your feedback!</p>
        <p className="field-hint">
          {status === 'published'
            ? 'It’s now part of our reviews, and we’ll use it to make Resizer better.'
            : 'We’ve received it and will read it carefully. Comments with links or contact details appear after a quick review.'}
        </p>
      </div>
    </div>
  );
}
