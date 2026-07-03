import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import DraftRatingWidget from './DraftRatingWidget';

export const dynamic = 'force-dynamic';

type DraftRequest = {
  id: string;
  employee_email: string;
  thread_id: string;
  instruction: string | null;
  status: string;
  draft_subject: string | null;
  draft_body: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  draft_rating: number | null;
  draft_feedback: string | null;
};

const EMPLOYEE_NAMES: Record<string, string> = {
  'alex@massivlust.no': 'Alex',
  'eivind@massivlust.no': 'Eivind',
  'vegard@massivlust.no': 'Vegard',
  'martin@massivlust.no': 'Martin',
};

function supabaseEnv() {
  const url = process.env.MASSIVLUST_SUPABASE_URL;
  const key = process.env.MASSIVLUST_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

async function fetchDrafts(): Promise<DraftRequest[]> {
  const env = supabaseEnv();
  if (!env) return [];
  try {
    const res = await fetch(
      `${env.url}/rest/v1/mail_draft_requests?status=in.(completed,error)&select=*&order=created_at.desc&limit=30`,
      {
        headers: {
          apikey: env.key,
          Authorization: `Bearer ${env.key}`,
        },
        cache: 'no-store',
      }
    );
    if (!res.ok) return [];
    return (await res.json()) as DraftRequest[];
  } catch {
    return [];
  }
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('nb-NO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function statusBadge(status: string, rating: number | null) {
  if (status === 'error') return <Badge variant="destructive">Feil</Badge>;
  if (rating != null) return <Badge variant="secondary">Vurdert {rating}/10</Badge>;
  return <Badge variant="outline">Venter vurdering</Badge>;
}

export default async function UtkastPage() {
  const drafts = await fetchDrafts();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">E-postutkast</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Genererte utkast fra AI-agenten. Vurder hvert utkast for å forbedre kvaliteten.
        </p>
      </div>

      {drafts.length === 0 && (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground text-center py-12">
            Ingen utkast ennå. Trykk &ldquo;Generer utkast&rdquo; i en e-posttråd for å komme i gang.
          </CardContent>
        </Card>
      )}

      <div className="space-y-4">
        {drafts.map((draft) => (
          <Card key={draft.id}>
            <CardContent className="pt-5">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="min-w-0">
                  <p className="font-medium truncate">
                    {draft.draft_subject ?? draft.instruction ?? '(uten emne)'}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {EMPLOYEE_NAMES[draft.employee_email] ?? draft.employee_email}
                    {' · '}
                    {formatDate(draft.created_at)}
                  </p>
                </div>
                <div className="shrink-0">
                  {statusBadge(draft.status, draft.draft_rating)}
                </div>
              </div>

              {draft.status === 'error' ? (
                <p className="text-sm text-destructive bg-destructive/5 rounded-md px-3 py-2">
                  {draft.error_message ?? 'Ukjent feil'}
                </p>
              ) : draft.draft_body ? (
                <pre className="text-sm whitespace-pre-wrap font-sans leading-relaxed bg-muted/40 rounded-md px-3 py-3 max-h-64 overflow-y-auto">
                  {draft.draft_body}
                </pre>
              ) : null}

              {draft.status === 'completed' && draft.draft_body && (
                <DraftRatingWidget
                  draftId={draft.id}
                  initialRating={draft.draft_rating}
                  initialFeedback={draft.draft_feedback}
                />
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
