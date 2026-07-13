import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.MASSIVLUST_SUPABASE_URL;
const SUPABASE_KEY = process.env.MASSIVLUST_SUPABASE_SERVICE_ROLE_KEY;

export async function POST(request: NextRequest) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
  }

  let body: { id: string; rating: number; feedback?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { id, rating, feedback } = body;
  if (!id || typeof rating !== 'number' || rating < 0 || rating > 10) {
    return NextResponse.json({ error: 'id and rating (0-10) required' }, { status: 400 });
  }

  const patch: Record<string, unknown> = { draft_rating: rating };
  if (feedback !== undefined) patch.draft_feedback = feedback;

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/mail_draft_requests?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(patch),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json({ error: text }, { status: res.status });
  }

  return NextResponse.json({ ok: true });
}
