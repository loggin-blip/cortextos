import * as gmail from '../lib/gmail.js';
import * as drive from '../lib/google-drive.js';
import { supabase } from '../supabase.js';
import * as syncRuns from '../sync-runs.js';
import { logger } from '../logger.js';

const BATCH_LIMIT = Number(process.env.VEDLEGG_BATCH_LIMIT) || 20;
const MAX_SIZE_BYTES = Number(process.env.VEDLEGG_MAX_SIZE_BYTES) || 25 * 1024 * 1024;

export async function run({ mode = 'incremental', dryRun = false } = {}) {
  const source = 'mail_vedlegg';
  const runId = await syncRuns.start({ source });

  try {
    const limit = mode === 'backfill' ? 200 : BATCH_LIMIT;
    const { data: candidates, error } = await supabase.rpc('massivlust_mail_vedlegg_candidates', { p_limit: limit });
    if (error) throw error;

    logger.info({ candidates: candidates?.length || 0 }, 'Mail-vedlegg candidates');

    let uploaded = 0, skipped = 0, failed = 0, considered = 0;

    for (const cand of (candidates || [])) {
      const { data: row, error: rowErr } = await supabase
        .from('massivlust_korrespondanse')
        .select('gmail_message_id, project_id, dato, source_mailbox, emne, raw_payload')
        .eq('gmail_message_id', cand.gmail_message_id)
        .maybeSingle();
      if (rowErr || !row) { failed++; continue; }

      const attachments = gmail.findAttachments(row.raw_payload?.payload || {});
      if (attachments.length === 0) {
        if (!dryRun) await markProcessed(cand.gmail_message_id);
        continue;
      }

      const folder = await pickTargetFolder(row.project_id);
      if (!folder) {
        logger.warn({ projectId: row.project_id }, 'No target Drive folder — skipping');
        skipped += attachments.length;
        if (!dryRun) await markProcessed(cand.gmail_message_id);
        continue;
      }

      let rowHadFailure = false;
      for (const att of attachments) {
        considered++;
        try {
          if (att.sizeBytes > MAX_SIZE_BYTES) {
            logger.warn({ msgId: row.gmail_message_id, filename: att.filename, size: att.sizeBytes }, 'Attachment too large — skipping');
            skipped++;
            continue;
          }

          if (dryRun) {
            logger.info({ msgId: row.gmail_message_id, filename: att.filename, folder: folder.name, sizeKb: Math.round(att.sizeBytes / 1024) }, 'DRY-RUN would upload');
            uploaded++;
            continue;
          }

          const buffer = await gmail.getAttachment(row.gmail_message_id, att.attachmentId, row.source_mailbox);
          const safeName = buildFilename(row.dato, row.gmail_message_id, att.filename);
          const uploadedFile = await drive.uploadFile({
            folderId: folder.drive_folder_id,
            name: safeName,
            mimeType: att.mimeType,
            buffer,
            impersonateEmail: row.source_mailbox,
          });

          const { error: insErr } = await supabase.from('massivlust_dokumenter').insert({
            project_id: row.project_id,
            type: 'mail_vedlegg',
            drive_file_id: uploadedFile.id,
            filnavn: safeName,
            mime_type: att.mimeType,
            file_size_bytes: att.sizeBytes,
            drive_folder_id: folder.drive_folder_id,
            dato: new Date(row.dato).toISOString().slice(0, 10),
            org_id: 'massivlust',
            source_gmail_message_id: row.gmail_message_id,
            source_gmail_part_id: att.partId,
            source_mailbox: row.source_mailbox,
          });
          if (insErr && !insErr.message.includes('duplicate')) throw insErr;
          uploaded++;
        } catch (err) {
          failed++;
          rowHadFailure = true;
          logger.error({ msgId: row.gmail_message_id, filename: att.filename, err: err.message }, 'Vedlegg upload failed');
        }
      }

      if (!dryRun && !rowHadFailure) await markProcessed(cand.gmail_message_id);
    }

    await syncRuns.complete(runId, {
      status: failed === 0 ? 'success' : 'partial',
      rows_in: considered,
      rows_upserted: uploaded,
      rows_skipped: skipped,
      rows_failed: failed,
    });

    return { uploaded, skipped, failed, considered };
  } catch (err) {
    await syncRuns.complete(runId, { status: 'error', error_message: err.message });
    throw err;
  }
}

async function markProcessed(gmailMessageId) {
  const { error } = await supabase
    .from('massivlust_korrespondanse')
    .update({ vedlegg_processed_at: new Date().toISOString() })
    .eq('gmail_message_id', gmailMessageId);
  if (error) logger.warn({ msgId: gmailMessageId, err: error.message }, 'Failed to mark vedlegg_processed_at');
}

async function pickTargetFolder(projectId) {
  const { data } = await supabase
    .from('massivlust_drive_folders')
    .select('drive_folder_id, name')
    .eq('project_id', projectId)
    .or('name.ilike.03 Mail%,name.ilike.04 Dokumenter%')
    .order('name', { ascending: true });
  if (!data || data.length === 0) return null;
  const mail = data.find(f => f.name.startsWith('03 Mail'));
  return mail || data.find(f => f.name.startsWith('04 Dokumenter')) || null;
}

function buildFilename(dato, messageId, original) {
  const date = new Date(dato).toISOString().slice(0, 10);
  const shortId = messageId.slice(-8);
  const sanitized = original.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 200);
  return `${date}_${shortId}_${sanitized}`;
}
