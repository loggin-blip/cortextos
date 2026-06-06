/**
 * Dashboard → Cortex bridge.
 *
 * Poller `massivlust_agent_messages` for uprocesserte dashboard-inbound-rader
 * og injecter teksten til riktig agent via AgentManager.injectAgentDetailed.
 *
 * Hvorfor polling og ikke realtime websocket? Cortex har ikke @supabase/supabase-js
 * som dependency, og vi vil ikke legge til en stor SDK bare for dette. 3 sek
 * poll-interval er greit for chat-bruk.
 *
 * Best-effort: alle nettverksfeil logges men daemon krasjer aldri.
 * Idempotency: rader markeres `processed=true` så samme melding ikke
 * injectes to ganger.
 */

import { join } from 'path';
import { resolveEnv, sourceEnvFile } from '../utils/env.js';
import type { AgentManager } from './agent-manager.js';

interface DashboardMsgRow {
  id: string;
  agent_id: string;
  text: string;
  metadata: Record<string, unknown> | null;
}

const POLL_INTERVAL_MS = 3000;
const FETCH_LIMIT = 10;

function ensureSupabaseEnvLoaded(): void {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    const env = resolveEnv();
    if (env.frameworkRoot) {
      sourceEnvFile(join(env.frameworkRoot, '.env'));
    }
  } catch { /* best effort */ }
}

export class DashboardBridge {
  private timer: NodeJS.Timeout | null = null;
  private agentManager: AgentManager;
  private supabaseUrl = '';
  private serviceKey = '';
  private running = false;
  private inFlight = false;

  constructor(agentManager: AgentManager) {
    this.agentManager = agentManager;
  }

  start(): void {
    ensureSupabaseEnvLoaded();
    this.supabaseUrl = process.env.SUPABASE_URL || '';
    this.serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!this.supabaseUrl || !this.serviceKey) {
      console.log('[dashboard-bridge] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — bridge disabled');
      return;
    }
    if (this.running) return;
    this.running = true;
    console.log(`[dashboard-bridge] Started (poll every ${POLL_INTERVAL_MS}ms)`);
    // Første poll umiddelbart, så på interval
    setImmediate(() => this.poll());
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    console.log('[dashboard-bridge] Stopped');
  }

  private async poll(): Promise<void> {
    if (this.inFlight) return; // skip overlap hvis forrige poll fortsatt jobber
    this.inFlight = true;
    try {
      const url =
        `${this.supabaseUrl}/rest/v1/massivlust_agent_messages` +
        `?processed=eq.false&direction=eq.inbound` +
        `&order=created_at.asc&limit=${FETCH_LIMIT}` +
        `&select=id,agent_id,text,metadata`;
      const res = await fetch(url, {
        headers: {
          apikey: this.serviceKey,
          Authorization: `Bearer ${this.serviceKey}`,
        },
      });
      if (!res.ok) {
        console.warn(`[dashboard-bridge] Poll HTTP ${res.status}`);
        return;
      }
      const rows = (await res.json()) as DashboardMsgRow[];
      for (const row of rows) {
        await this.handleRow(row);
      }
    } catch (err) {
      console.error('[dashboard-bridge] Poll error:', (err as Error).message);
    } finally {
      this.inFlight = false;
    }
  }

  private async handleRow(row: DashboardMsgRow): Promise<void> {
    const isDashboard = row.metadata && (row.metadata as { source?: unknown }).source === 'dashboard';
    if (!isDashboard) {
      // Ikke en dashboard-melding (kan være eldre Cortex-skrevet inbound uten processed=true).
      // Marker som processed så vi ikke retryer for evig.
      await this.markProcessed(row.id);
      return;
    }

    const result = this.agentManager.injectAgentDetailed(row.agent_id, row.text);

    if (result.ok) {
      console.log(`[dashboard-bridge] Injected → ${row.agent_id}: "${row.text.slice(0, 80)}"`);
      await this.markProcessed(row.id);
      return;
    }

    // NOT_FOUND: agenten finnes ikke i registry → marker processed, ingen vits å retrye
    if (result.code === 'NOT_FOUND') {
      console.warn(`[dashboard-bridge] Agent ikke funnet "${row.agent_id}" — markerer processed`);
      await this.markProcessed(row.id);
      return;
    }

    // NOT_RUNNING (agent registret men PTY død): la den være, neste poll kan plukke opp
    // DEDUPED: samme tekst injected nylig, antas allerede prosessert → marker processed
    if (result.code === 'DEDUPED') {
      console.log(`[dashboard-bridge] Deduped → ${row.agent_id}, markerer processed`);
      await this.markProcessed(row.id);
      return;
    }

    console.warn(`[dashboard-bridge] Inject feilet (${result.code}) for ${row.agent_id}, retry neste poll`);
  }

  private async markProcessed(id: string): Promise<void> {
    try {
      const url = `${this.supabaseUrl}/rest/v1/massivlust_agent_messages?id=eq.${id}`;
      await fetch(url, {
        method: 'PATCH',
        headers: {
          apikey: this.serviceKey,
          Authorization: `Bearer ${this.serviceKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          processed: true,
          processed_at: new Date().toISOString(),
        }),
      });
    } catch (err) {
      console.error('[dashboard-bridge] markProcessed error:', (err as Error).message);
    }
  }
}
