import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { spawnSync } from 'node:child_process'
import { promises as fs, watch } from 'node:fs'
import path from 'node:path'

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_ROLE  = process.env.SUPABASE_SERVICE_ROLE_KEY
const CORTEXTOS_BIN = process.env.CORTEXTOS_BIN || '/opt/homebrew/bin/cortextos'
const CTX_ROOT      = process.env.CTX_ROOT || `${process.env.HOME}/.cortextos/default`
const CTX_ORG       = process.env.CTX_ORG || 'westside-hq'
const CATCHUP_SEC   = parseInt(process.env.CATCHUP_INTERVAL_SEC || '30', 10)

const INBOX_DIR     = path.join(CTX_ROOT, 'inbox', 'bridge')
const PROCESSED_DIR = path.join(CTX_ROOT, 'processed', 'bridge')

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false }
})

function log(level, ...args) {
  console.log(`${new Date().toISOString()} [${level}]`, ...args)
}

// ============================================================
// MACBOOK → STUDIO: handle outgoing rows (from macbook sessions)
// ============================================================
async function handleOutgoing(row) {
  log('INFO', 'OUT →', row.to_agent, 'msg_id=', row.msg_id)

  const env = {
    ...process.env,
    CTX_AGENT_NAME: 'bridge',
    CTX_ORG: CTX_ORG,
    PATH: (process.env.PATH || '') + ':/opt/homebrew/bin'
  }

  const result = spawnSync(CORTEXTOS_BIN, [
    'bus', 'send-message',
    row.to_agent, 'normal', row.text
  ], { env, encoding: 'utf8' })

  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || 'unknown error').trim()
    log('ERROR', 'SEND FAILED:', err)
    await supabase.from('cortextos_bridge_messages').update({
      status: 'failed',
      error_text: err.slice(0, 500)
    }).eq('id', row.id)
    return
  }

  const out = (result.stdout || '').trim()
  const m = out.match(/(\d+-[a-z0-9-]+-[a-z0-9]+)/)
  const busMsgId = m ? m[1] : null

  await supabase.from('cortextos_bridge_messages').update({
    status: 'delivered',
    delivered_at: new Date().toISOString(),
    meta: { ...(row.meta || {}), bus_msg_id: busMsgId, bus_output: out.slice(0, 300) }
  }).eq('id', row.id)

  log('INFO', 'DELIVERED:', row.msg_id, '→ bus_msg_id=', busMsgId)
}

// ============================================================
// STUDIO → MACBOOK: handle incoming inbox files
// ============================================================
async function handleIncomingFile(filePath) {
  let raw, msg
  try {
    raw = await fs.readFile(filePath, 'utf8')
    msg = JSON.parse(raw)
  } catch (e) {
    log('WARN', 'Cant read/parse', path.basename(filePath), '-', e.message)
    return
  }

  log('INFO', 'IN ←', msg.from, 'reply_to=', msg.reply_to || '(none)')

  let originalMacbookMsgId = null
  if (msg.reply_to) {
    const { data: orig, error } = await supabase
      .from('cortextos_bridge_messages')
      .select('msg_id, id')
      .eq('meta->>bus_msg_id', msg.reply_to)
      .maybeSingle()

    if (error) log('WARN', 'lookup error', error.message)
    if (orig) {
      originalMacbookMsgId = orig.msg_id
      await supabase.from('cortextos_bridge_messages').update({
        status: 'replied',
        replied_at: new Date().toISOString()
      }).eq('id', orig.id)
    } else {
      log('WARN', 'No matching outgoing row for bus_msg_id', msg.reply_to)
    }
  }

  const newMsgId = `${Date.now()}-bridge-${Math.random().toString(36).slice(2, 7)}`
  const { error: insertErr } = await supabase
    .from('cortextos_bridge_messages').insert({
      msg_id: newMsgId,
      from_agent: msg.from,
      to_agent: 'macbook',
      text: msg.text,
      reply_to: originalMacbookMsgId,
      status: 'delivered',
      delivered_at: new Date().toISOString(),
      machine_origin: 'studio',
      meta: { bus_msg_id: msg.id, original_file: path.basename(filePath) }
    })

  if (insertErr) {
    log('ERROR', 'insert reply failed', insertErr.message)
    return
  }

  // Move file from inbox → processed
  try {
    await fs.mkdir(PROCESSED_DIR, { recursive: true })
    await fs.rename(filePath, path.join(PROCESSED_DIR, path.basename(filePath)))
  } catch (e) {
    log('WARN', 'rename failed', e.message)
  }

  log('INFO', 'REPLAYED →', newMsgId, originalMacbookMsgId ? `(reply_to ${originalMacbookMsgId})` : '(unsolicited)')
}

// ============================================================
// Setup
// ============================================================
await fs.mkdir(INBOX_DIR, { recursive: true })
await fs.mkdir(PROCESSED_DIR, { recursive: true })

// Realtime subscription on new outgoing messages
const channel = supabase
  .channel('bridge-outgoing')
  .on('postgres_changes', {
    event: 'INSERT',
    schema: 'public',
    table: 'cortextos_bridge_messages',
    filter: 'machine_origin=eq.macbook'
  }, (payload) => {
    if (payload.new && payload.new.status === 'pending') {
      handleOutgoing(payload.new).catch(e => log('ERROR', 'handleOutgoing', e.message))
    }
  })
  .subscribe((status) => log('INFO', 'REALTIME', status))

// Catch-up scan for pending rows (in case daemon was down)
async function catchUpScan() {
  try {
    const { data, error } = await supabase
      .from('cortextos_bridge_messages')
      .select('*')
      .eq('machine_origin', 'macbook')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(50)

    if (error) { log('WARN', 'catchup error', error.message); return }
    if (data.length) log('INFO', 'CATCH-UP:', data.length, 'pending rows')
    for (const row of data) await handleOutgoing(row)
  } catch (e) {
    log('ERROR', 'catchUpScan', e.message)
  }
}
catchUpScan()
setInterval(catchUpScan, CATCHUP_SEC * 1000)

// Scan inbox for any existing files (recovery on restart)
async function scanInbox() {
  try {
    const files = await fs.readdir(INBOX_DIR)
    for (const f of files) {
      if (f.endsWith('.json')) {
        await handleIncomingFile(path.join(INBOX_DIR, f))
      }
    }
  } catch (e) {
    log('WARN', 'scanInbox', e.message)
  }
}
scanInbox()

// Watch inbox for new files
const recentlyHandled = new Set()
watch(INBOX_DIR, async (event, filename) => {
  if (!filename || !filename.endsWith('.json')) return
  if (recentlyHandled.has(filename)) return
  recentlyHandled.add(filename)
  setTimeout(() => recentlyHandled.delete(filename), 5000)

  const fp = path.join(INBOX_DIR, filename)
  try {
    await fs.access(fp)
    // small delay to let writer finish atomic-write rename
    setTimeout(() => handleIncomingFile(fp).catch(e => log('ERROR', 'inboxWatcher', e.message)), 100)
  } catch {
    /* file removed already */
  }
})

log('INFO', 'Bridge online. Watching', INBOX_DIR)

process.on('SIGTERM', () => { log('INFO', 'SIGTERM, exiting'); process.exit(0) })
process.on('SIGINT',  () => { log('INFO', 'SIGINT, exiting');  process.exit(0) })
