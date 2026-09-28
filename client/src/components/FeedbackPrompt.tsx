import { useState } from 'react';
import { rememberFeedback, type FeedbackStatus } from '../lib/feedbackApi';
import { FeedbackForm, FeedbackThanks } from './FeedbackForm';

/**
 * Shown under the result after a download. Deliberately inline, not a modal:
 * it never interrupts the download or traps focus, and "Not now" silences it
 * for a week.
 */
export function FeedbackPrompt({ onClose, onSubmitted }: { onClose: () => void; onSubmitted: () => void }) {
  const [done, setDone] = useState<FeedbackStatus | null>(null);

  if (done) return <FeedbackThanks status={done} />;

  return (
    <section className="card feedback-prompt" aria-labelledby="feedback-prompt-title">
      <h2 id="feedback-prompt-title" className="feedback-title">
        How was your experience?
      </h2>
      <p className="feedback-lead">
        Your feedback genuinely helps us improve Resizer. We read every comment and apply suggestions wherever we can.
      </p>
      <FeedbackForm
        onCancel={() => {
          rememberFeedback('dismissed');
          onClose();
        }}
        onDone={(status) => {
          rememberFeedback('submitted');
          setDone(status);
          onSubmitted();
        }}
      />
    </section>
  );
}
