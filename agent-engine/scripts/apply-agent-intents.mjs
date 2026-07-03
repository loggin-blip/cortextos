#!/usr/bin/env node
/**
 * apply-agent-intents.mjs — UTFØR intent-køen mot de ekte cortextOS-filene.
 *
 * Dette er Studio-motoren: leser `massivlust_agent_intents` (status=pending) og
 * gjør endringen på `~/cortextos/orgs/massivlust/agents/{agent}/config.json`
 * (og agent-mapper ved create_agent). Setter status applied/failed + melding,
 * og kjører config-speilingen etterpå så dashbordet viser jobben som «aktiv».
 *
 * Kjør én gang:   node scripts/apply-agent-intents.mjs
 * Kontinuerlig:   cron/launchd på Studio-maskinen (hvert minutt) — se kickoff.
 * Dry-run:        node scripts/apply-agent-intents.mjs --dry  (skriver ikke filer/DB)
 *
 * Idempotent: kun pending behandles; dupliserte cron-navn hoppes over.
 * Se docs/PLAN_AGENT_SELVBETJENING.md + KICKOFF_STUDIO_AGENT_MIRROR.md (§5).
 */

import { readFile, writeFile, rename, mkdir } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execSync, execFileSync } from 'child_process';
import { createClient } from '@supabase/supabase-js';

const ORG_DIR = join(homedir(), 'cortextos', 'orgs', 'massivlust', 'agents');
const DRY = process.argv.includes('--dry');

// Agenter som styres fra massivlust-dashbordet men fysisk bor i en annen org.
// Hold i sync med EXTRA_AGENTS i sync-agent-config.mjs.
const EXTRA_DIRS = {
  'ks-avvik': join(homedir(), 'cortextos', 'orgs', 'westside-hq', 'agents', 'ks-avvik'),
};
/** Finn agent-mappa — sjekker EXTRA_DIRS før massivlust-org. */
function agentDir(agentId) {
  return EXTRA_DIRS[agentId] || join(ORG_DIR, agentId);
}

function loadEnv() {
  const out = {};
  const path = join(process.cwd(), '.env.local');
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** Atomisk skriv: temp → rename. */
async function writeJson(path, obj) {
  if (DRY) { console.log(`    [dry] ville skrevet ${path}`); return; }
  const tmp = `${path}.tmp-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  await rename(tmp, path);
}

function slugify(s) {
  return String(s || 'agent').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';
}

// ── Handlers per kind ───────────────────────────────────────────────────────
async function applyCreateCron(intent) {
  const dir = agentDir(intent.agent_id);
  const cfgPath = join(dir, 'config.json');
  if (!existsSync(cfgPath)) throw new Error(`config.json mangler for ${intent.agent_id}`);
  const cfg = await readJson(cfgPath);
  const p = intent.payload || {};
  const name = p.name || 'Ny jobb';
  cfg.crons = Array.isArray(cfg.crons) ? cfg.crons : [];
  if (cfg.crons.some((c) => c && c.name === name)) {
    return `Hoppet over — cron «${name}» finnes allerede`;
  }
  const prompt = p.needsApproval
    ? `(Be Alex om godkjenning via dashboardet før du utfører dette.) ${p.prompt || ''}`.trim()
    : (p.prompt || '');
  cfg.crons.push({ name, type: 'recurring', cron: p.cron, prompt });
  await writeJson(cfgPath, cfg);
  return `La til cron «${name}» (${p.cron}) i ${intent.agent_id}`;
}

async function applyToggle(intent) {
  const cfgPath = join(agentDir(intent.agent_id), 'config.json');
  if (!existsSync(cfgPath)) throw new Error(`config.json mangler for ${intent.agent_id}`);
  const cfg = await readJson(cfgPath);
  cfg.enabled = intent.payload?.enabled === true;
  await writeJson(cfgPath, cfg);
  return `Satte enabled=${cfg.enabled} for ${intent.agent_id}`;
}

// Slett en cron-jobb (matcher på navn).
async function applyDeleteCron(intent) {
  const cfgPath = join(agentDir(intent.agent_id), 'config.json');
  if (!existsSync(cfgPath)) throw new Error(`config.json mangler for ${intent.agent_id}`);
  const cfg = await readJson(cfgPath);
  const name = intent.payload?.name;
  if (!name) throw new Error('mangler jobbnavn');
  const list = Array.isArray(cfg.crons) ? cfg.crons : [];
  const next = list.filter((c) => !(c && c.name === name));
  if (next.length === list.length) return `Fant ingen jobb «${name}» — ingen endring`;
  cfg.crons = next;
  await writeJson(cfgPath, cfg);
  return `Slettet jobb «${name}» fra ${intent.agent_id}`;
}

// Rediger en eksisterende cron-jobb (matcher på navn; oppdaterer cron/prompt).
async function applyUpdateCron(intent) {
  const cfgPath = join(agentDir(intent.agent_id), 'config.json');
  if (!existsSync(cfgPath)) throw new Error(`config.json mangler for ${intent.agent_id}`);
  const cfg = await readJson(cfgPath);
  const p = intent.payload || {};
  const name = p.name;
  if (!name) throw new Error('mangler jobbnavn');
  const list = Array.isArray(cfg.crons) ? cfg.crons : [];
  const idx = list.findIndex((c) => c && c.name === name);
  if (idx < 0) return `Fant ingen jobb «${name}» — ingen endring`;
  if (typeof p.cron === 'string') list[idx].cron = p.cron;
  if (typeof p.prompt === 'string') list[idx].prompt = p.prompt;
  cfg.crons = list;
  await writeJson(cfgPath, cfg);
  return `Oppdaterte jobb «${name}» for ${intent.agent_id}`;
}

// Skru en godkjenn-regel av/på = legg til/fjern kategori i approval_rules.always_ask.
// Bevarer never_ask urørt (speilingen viser ikke never_ask, så update_config ville
// nullet den — derfor en dedikert handler som kun rører always_ask).
async function applyToggleApproval(intent) {
  const cfgPath = join(agentDir(intent.agent_id), 'config.json');
  if (!existsSync(cfgPath)) throw new Error(`config.json mangler for ${intent.agent_id}`);
  const cfg = await readJson(cfgPath);
  const cat = intent.payload?.category;
  const on = intent.payload?.enabled === true;
  if (!cat) throw new Error('mangler kategori');
  const rules = (cfg.approval_rules && typeof cfg.approval_rules === 'object') ? cfg.approval_rules : {};
  const always = Array.isArray(rules.always_ask) ? rules.always_ask.slice() : [];
  const has = always.includes(cat);
  if (on === has) return `Ingen endring — «${cat}» allerede ${on ? 'på' : 'av'}`;
  const next = on ? [...always, cat] : always.filter((c) => c !== cat);
  cfg.approval_rules = {
    ...rules,
    always_ask: next,
    never_ask: Array.isArray(rules.never_ask) ? rules.never_ask : [],
  };
  await writeJson(cfgPath, cfg);
  return `Satte godkjenn-regel «${cat}» = ${on ? 'på' : 'av'} for ${intent.agent_id}`;
}

// Skriv et mandat-.md (GOALS/GUARDRAILS) atomisk. Kun menneske-skrevet mandat er
// tillatt herfra — MEMORY/IDENTITY/SOUL avvises (agenten eier de, se EDITABLE_MARKDOWN).
const MARKDOWN_FILES = { GOALS: 'GOALS.md', GUARDRAILS: 'GUARDRAILS.md' };
async function applyUpdateMarkdown(intent) {
  const dir = agentDir(intent.agent_id);
  if (!existsSync(dir)) throw new Error(`agent-mappe mangler for ${intent.agent_id}`);
  const p = intent.payload || {};
  const fname = MARKDOWN_FILES[p.file];
  if (!fname) throw new Error(`ulovlig fil «${p.file}» — kun GOALS/GUARDRAILS`);
  if (typeof p.content !== 'string') throw new Error('mangler innhold');
  const content = p.content.length > 20000 ? p.content.slice(0, 20000) : p.content;
  const path = join(dir, fname);
  if (DRY) { console.log(`    [dry] ville skrevet ${path} (${content.length} tegn)`); return `[dry] ${fname}`; }
  const tmp = `${path}.tmp-${Date.now()}`;
  await writeFile(tmp, content.endsWith('\n') ? content : content + '\n', 'utf8');
  await rename(tmp, path);
  return `Skrev ${fname} (${content.length} tegn) for ${intent.agent_id}`;
}

async function applyUpdateConfig(intent) {
  const cfgPath = join(agentDir(intent.agent_id), 'config.json');
  if (!existsSync(cfgPath)) throw new Error(`config.json mangler for ${intent.agent_id}`);
  const cfg = await readJson(cfgPath);
  const fields = intent.payload?.fields || intent.payload || {};
  for (const [k, v] of Object.entries(fields)) cfg[k] = v;
  await writeJson(cfgPath, cfg);
  return `Oppdaterte ${Object.keys(fields).length} felt for ${intent.agent_id}`;
}

// Skriv en godkjenn-beslutning tilbake til cortextOS via den innebygde bus-CLI-en.
// `update-approval` flytter approval-fila pending→resolved OG sender inbox-melding
// til agenten (som gjenopptar) — hele loopen bevares ved å kalle samme CLI som
// bus/update-approval.sh. approvalDir utledes av CTX_INSTANCE_ID + CTX_ORG, så vi
// peker bus-en mot riktig org (massivlust ELLER westside-hq for ks-avvik).
async function applyResolveApproval(intent, db) {
  const p = intent.payload || {};
  const approvalId = p.approvalId;
  const decision = p.decision;
  const note = typeof p.note === 'string' ? p.note.slice(0, 500) : '';
  const sourceOrg = p.sourceOrg || 'massivlust';
  if (!approvalId) throw new Error('mangler approvalId');
  if (decision !== 'approved' && decision !== 'rejected') throw new Error(`ulovlig beslutning «${decision}»`);

  const cliPath = join(homedir(), 'cortextos', 'dist', 'cli.js');
  if (!existsSync(cliPath)) throw new Error(`fant ikke cortextOS-CLI på ${cliPath}`);
  if (DRY) return `[dry] ville satt ${approvalId} = ${decision} (org ${sourceOrg})`;

  const env = {
    ...process.env,
    CTX_INSTANCE_ID: process.env.CTX_INSTANCE_ID || 'default',
    CTX_ROOT: join(homedir(), '.cortextos', process.env.CTX_INSTANCE_ID || 'default'),
    CTX_FRAMEWORK_ROOT: join(homedir(), 'cortextos'),
    CTX_ORG: sourceOrg,
    CTX_AGENT_NAME: 'system',
  };
  const args = [cliPath, 'bus', 'update-approval', approvalId, decision];
  if (note) args.push(note);
  try {
    execFileSync(process.execPath, args, { env, stdio: 'pipe', encoding: 'utf8' });
  } catch (e) {
    const out = (e.stderr || e.stdout || e.message || '').toString().trim();
    throw new Error(`bus update-approval feilet: ${out.slice(0, 300)}`);
  }

  // Oppdater speilet umiddelbart (status != pending → stale-oppryddingen rører den ikke).
  if (db) {
    const now = new Date().toISOString();
    await db.from('massivlust_agent_approvals')
      .update({ status: decision, resolved_at: now, resolved_by: note || null, decided_via: 'dashboard', updated_at: now })
      .eq('id', approvalId);
  }
  return `Satte godkjenning ${approvalId} = ${decision}${note ? ` («${note}»)` : ''} (org ${sourceOrg})`;
}

async function applyCreateAgent(intent, db) {
  // Scaffold agent-mappe + minimal config + identitet. Telegram-bot + allow-list
  // i dashbordet (AGENT_DISPLAY) + runtime-provisjonering gjenstår (Studio/manuelt).
  const p = intent.payload || {};
  const slug = slugify(p.name || (intent.kind === 'onboarding' ? `${p.owner}-assistent` : 'ny-agent'));
  const dir = join(ORG_DIR, slug);
  if (existsSync(dir)) return `Hoppet over — agent-mappe «${slug}» finnes allerede`;
  if (DRY) return `[dry] ville scaffoldet agent «${slug}»`;
  await mkdir(dir, { recursive: true });
  const tasks = Array.isArray(p.tasks) ? p.tasks : [];
  const cfg = {
    agent_name: slug,
    display_name: p.name || slug,
    model: p.model || 'claude-sonnet-4-6',
    enabled: false, // starter avslått til runtime/Telegram er koblet
    owner: p.owner || null,
    communication_style: 'casual',
    day_mode_start: '07:00',
    day_mode_end: '16:00',
    crons: [],
    approval_rules: { always_ask: ['external-comms', 'financial', 'data-deletion'], never_ask: [] },
    _provisioning: { source: 'dashboard-intent', intent_id: intent.id, telegram: 'pending', created_via: intent.kind },
  };
  await writeFile(join(dir, 'config.json'), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  const ident = `# ${p.name || slug}\n\nEier: ${p.owner || 'ukjent'}\nOpprettet via dashboard-onboarding.\n`;
  await writeFile(join(dir, 'IDENTITY.md'), ident, 'utf8');
  const goals = `# Mål\n\n${tasks.length ? tasks.map((t) => `- ${t}`).join('\n') : '- (fylles ut)'}\n${p.note ? `\nNotat: ${p.note}\n` : ''}`;
  await writeFile(join(dir, 'GOALS.md'), goals, 'utf8');

  // Legg agenten i registeret → den dukker opp i dashbordet med en gang
  // (avslått til Telegram/runtime er koblet).
  if (db) {
    const reg = await db.from('massivlust_agents').upsert([{
      agent_id: slug,
      org_id: 'massivlust',
      display_name: p.name || slug,
      emoji: p.emoji || (intent.kind === 'onboarding' ? '🧰' : '🤖'),
      role: p.owner ? `Personlig assistent · ${p.owner}` : 'Ny agent',
      enabled: false,
      is_personal: intent.kind === 'onboarding',
      owner: p.owner || null,
      source: 'intent',
    }], { onConflict: 'agent_id', ignoreDuplicates: true });
    if (reg.error) console.log(`    ⚠ registry: ${reg.error.message}`);
  }
  return `Scaffoldet agent «${slug}» + lagt i registeret (avslått til Telegram/runtime koblet)`;
}

const HANDLERS = {
  create_cron: applyCreateCron,
  delete_cron: applyDeleteCron,
  update_cron: applyUpdateCron,
  toggle_agent: applyToggle,
  toggle_approval: applyToggleApproval,
  update_markdown: applyUpdateMarkdown,
  update_config: applyUpdateConfig,
  resolve_approval: applyResolveApproval,
  create_agent: applyCreateAgent,
  onboarding: applyCreateAgent,
};

async function main() {
  const env = loadEnv();
  const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('✖ Mangler SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
  if (!existsSync(ORG_DIR)) { console.error(`✖ Fant ikke ${ORG_DIR} — kjør på Studio-maskinen`); process.exit(1); }

  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await db
    .from('massivlust_agent_intents')
    .select('*')
    .eq('org_id', 'massivlust')
    .eq('status', 'pending')
    .order('requested_at', { ascending: true });
  if (error) { console.error('✖ Query feilet:', error.message); process.exit(1); }

  const intents = data ?? [];
  if (!intents.length) { console.log('✓ Ingen ventende intents.'); return; }
  console.log(`🔧 ${intents.length} ventende intent(s)${DRY ? ' (DRY-RUN)' : ''}\n`);

  let touchedConfig = false;
  for (const it of intents) {
    const handler = HANDLERS[it.kind];
    if (!handler) { console.log(`  ⚠ ${it.kind}: ingen handler — hopper over`); continue; }
    try {
      const note = await handler(it, db);
      if (['create_cron', 'delete_cron', 'update_cron', 'toggle_agent', 'toggle_approval', 'update_markdown', 'update_config'].includes(it.kind)) touchedConfig = true;
      if (!DRY) {
        await db.from('massivlust_agent_intents')
          .update({ status: 'applied', applied_at: new Date().toISOString(), result_note: note })
          .eq('id', it.id).eq('status', 'pending');
      }
      console.log(`  ✓ ${it.kind} (${it.agent_id ?? '—'}): ${note}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!DRY) {
        await db.from('massivlust_agent_intents')
          .update({ status: 'failed', result_note: msg }).eq('id', it.id).eq('status', 'pending');
      }
      console.log(`  ✖ ${it.kind} (${it.agent_id ?? '—'}): FEIL — ${msg}`);
    }
  }

  // Speil oppdatert config tilbake så dashbordet viser jobben som «aktiv».
  if (touchedConfig && !DRY) {
    console.log('\n🔄 Speiler oppdatert config til Supabase…');
    try {
      execSync('node scripts/sync-agent-config.mjs', { stdio: 'inherit', cwd: process.cwd() });
    } catch {
      console.log('  ⚠ Klarte ikke kjøre sync-agent-config.mjs automatisk — kjør den manuelt.');
    }
  }
  console.log('\n✅ Ferdig.');
}

main().catch((e) => { console.error('✖ Uventet feil:', e); process.exit(1); });
