'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

interface Props {
  draftId: string;
  initialRating?: number | null;
  initialFeedback?: string | null;
}

export default function DraftRatingWidget({ draftId, initialRating, initialFeedback }: Props) {
  const [selected, setSelected] = useState<number | null>(initialRating ?? null);
  const [feedback, setFeedback] = useState(initialFeedback ?? '');
  const [submitted, setSubmitted] = useState(initialRating != null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (selected === null) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/massivlust/rate-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: draftId, rating: selected, feedback: feedback || undefined }),
      });
      if (!res.ok) throw new Error(await res.text());
      setSubmitted(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Noe gikk galt');
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return (
      <div className="mt-4 pt-4 border-t border-border">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center h-8 w-8 rounded-full bg-primary text-primary-foreground text-sm font-semibold shrink-0">
            {selected}
          </div>
          <p className="text-sm text-muted-foreground">
            Vurdering lagret. Takk — dette hjelper oss å lage bedre utkast.
          </p>
          <button
            onClick={() => setSubmitted(false)}
            className="ml-auto text-xs text-muted-foreground hover:text-foreground underline"
          >
            Endre
          </button>
        </div>
        {feedback && (
          <p className="mt-2 text-xs text-muted-foreground italic pl-11">{feedback}</p>
        )}
      </div>
    );
  }

  return (
    <div className="mt-4 pt-4 border-t border-border space-y-3">
      <p className="text-xs text-muted-foreground font-medium">
        Vurder utkastet — din tilbakemelding forbedrer fremtidige utkast
      </p>

      <div className="flex flex-wrap gap-1.5">
        {Array.from({ length: 11 }, (_, i) => (
          <button
            key={i}
            onClick={() => setSelected(i)}
            className={`h-8 w-8 rounded-md text-sm font-medium transition-colors border ${
              selected === i
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background hover:bg-muted border-border text-foreground'
            }`}
          >
            {i}
          </button>
        ))}
      </div>

      {selected !== null && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className={selected <= 4 ? 'text-destructive' : selected <= 7 ? 'text-amber-600' : 'text-emerald-600'}>
              {selected <= 4 ? 'Trenger forbedring' : selected <= 7 ? 'Bra, men kan bli bedre' : 'Veldig bra'}
            </span>
          </div>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Hva kan forbedres? (valgfritt)"
            rows={2}
            className="w-full text-sm rounded-md border border-border bg-background px-3 py-2 resize-none placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button size="sm" onClick={submit} disabled={loading}>
            {loading ? 'Sender...' : 'Send vurdering'}
          </Button>
        </div>
      )}
    </div>
  );
}
