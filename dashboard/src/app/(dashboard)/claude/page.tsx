import { discoverAgents } from '@/lib/data/agents';
import { ClaudeTerminal } from './client';

export const dynamic = 'force-dynamic';

export default async function ClaudePage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string; org?: string }>;
}) {
  const { agent: selectedAgent, org } = await searchParams;

  const agents = await discoverAgents(org);
  const agentNames = agents
    .map((a) => a.name)
    .filter((n) => /^[\w-]+$/.test(n))
    .sort();

  const defaultAgent = selectedAgent ?? agentNames[0] ?? '';

  return <ClaudeTerminal agents={agentNames} defaultAgent={defaultAgent} />;
}
