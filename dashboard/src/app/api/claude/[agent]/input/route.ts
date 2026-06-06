import { NextRequest } from 'next/server';
import { IPCClient } from '@/lib/ipc-client';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ agent: string }> },
) {
  const { agent } = await params;

  if (!/^[\w-]+$/.test(agent)) {
    return Response.json({ error: 'Invalid agent name' }, { status: 400 });
  }

  let body: { text?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const text = body.text ?? '';
  if (!text.trim()) {
    return Response.json({ error: 'text required' }, { status: 400 });
  }

  const ipc = new IPCClient();
  const result = await ipc.send({
    type: 'inject-agent',
    agent,
    data: { text: text.endsWith('\n') ? text : text + '\n' },
  });

  return Response.json(result);
}
