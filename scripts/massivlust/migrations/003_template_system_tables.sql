-- Massivlust: schema alignment for template system (KS-bilder, dagrapport, avvik)
-- Dato: 2026-05-15
-- Ref: required schema for dashboard + montasje-pipeline

-- ============================================================
-- 1. massivlust_dagrapporter — ADD missing columns
-- ============================================================
-- Existing: id, project_id, montor_navn, dato, utfort, elementer, lukkes,
--           retro_bra, retro_daarlig, tiltak, nye_avvik, timer_rapportert,
--           timer_tripletex, timer_match, kilde, org_id, created_at

ALTER TABLE massivlust_dagrapporter
  ADD COLUMN IF NOT EXISTS montor_id TEXT,
  ADD COLUMN IF NOT EXISTS prosjekt_navn TEXT,
  ADD COLUMN IF NOT EXISTS aktivitet TEXT,
  ADD COLUMN IF NOT EXISTS ks_status TEXT,
  ADD COLUMN IF NOT EXISTS avvik_flagg BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS retro_kommentar TEXT,
  ADD COLUMN IF NOT EXISTS tripletex_entry_id TEXT;

COMMENT ON COLUMN massivlust_dagrapporter.montor_id IS 'Tripletex employee ID or internal ref';
COMMENT ON COLUMN massivlust_dagrapporter.prosjekt_navn IS 'Denormalized project name for quick display';
COMMENT ON COLUMN massivlust_dagrapporter.aktivitet IS 'Activity type: forarbeid, montasje, etterarbeid, etc.';
COMMENT ON COLUMN massivlust_dagrapporter.ks_status IS 'KS check status for this day entry';
COMMENT ON COLUMN massivlust_dagrapporter.avvik_flagg IS 'True if an avvik was linked to this dagrapport';
COMMENT ON COLUMN massivlust_dagrapporter.retro_kommentar IS 'Combined retro comment (supplements retro_bra/retro_daarlig)';
COMMENT ON COLUMN massivlust_dagrapporter.tripletex_entry_id IS 'Linked Tripletex timesheet entry ID';

-- ============================================================
-- 2. massivlust_avvik — ADD missing columns
-- ============================================================
-- Existing: id, project_id, avvik_nr, dato, montor_navn, beskrivelse,
--           foto_urls, sendt_til, leverandor, status, plan_for_lukking,
--           lukket_dato, lukket_av, org_id, created_at, updated_at

ALTER TABLE massivlust_avvik
  ADD COLUMN IF NOT EXISTS type TEXT,
  ADD COLUMN IF NOT EXISTS ansvarlig TEXT,
  ADD COLUMN IF NOT EXISTS drive_file_id TEXT;

COMMENT ON COLUMN massivlust_avvik.type IS 'Avvik type: spec-konflikt, fremdrifts-blokker, rettet-i-felt, etc.';
COMMENT ON COLUMN massivlust_avvik.ansvarlig IS 'Person responsible for resolving the avvik';
COMMENT ON COLUMN massivlust_avvik.drive_file_id IS 'Google Drive file ID for linked documentation';

-- ============================================================
-- 3. massivlust_ks_bilder — NEW table
-- ============================================================
CREATE TABLE IF NOT EXISTS massivlust_ks_bilder (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prosjekt_id UUID NOT NULL REFERENCES massivlust_projects(id) ON DELETE CASCADE,
  omrade TEXT NOT NULL,
  element TEXT,
  montor_id TEXT,
  montor_navn TEXT,
  dato DATE NOT NULL DEFAULT CURRENT_DATE,
  bilde_url TEXT,
  spec_tekst TEXT,
  godkjent_status TEXT DEFAULT 'pending' CHECK (godkjent_status IN ('pending', 'godkjent', 'avvik')),
  godkjent_av TEXT,
  drive_file_id TEXT,
  org_id TEXT DEFAULT 'massivlust' NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 4. Indexes
-- ============================================================
-- massivlust_dagrapporter — new column indexes
CREATE INDEX IF NOT EXISTS idx_ml_dagrapport_montor_id ON massivlust_dagrapporter(montor_id);
CREATE INDEX IF NOT EXISTS idx_ml_dagrapport_aktivitet ON massivlust_dagrapporter(aktivitet);
CREATE INDEX IF NOT EXISTS idx_ml_dagrapport_avvik_flagg ON massivlust_dagrapporter(avvik_flagg) WHERE avvik_flagg = true;

-- massivlust_avvik — new column indexes
CREATE INDEX IF NOT EXISTS idx_ml_avvik_type ON massivlust_avvik(type);
CREATE INDEX IF NOT EXISTS idx_ml_avvik_ansvarlig ON massivlust_avvik(ansvarlig);

-- massivlust_ks_bilder
CREATE INDEX IF NOT EXISTS idx_ml_ks_bilder_prosjekt ON massivlust_ks_bilder(prosjekt_id);
CREATE INDEX IF NOT EXISTS idx_ml_ks_bilder_dato ON massivlust_ks_bilder(dato);
CREATE INDEX IF NOT EXISTS idx_ml_ks_bilder_status ON massivlust_ks_bilder(godkjent_status);
CREATE INDEX IF NOT EXISTS idx_ml_ks_bilder_montor ON massivlust_ks_bilder(montor_id);
CREATE INDEX IF NOT EXISTS idx_ml_ks_bilder_omrade ON massivlust_ks_bilder(omrade);

-- ============================================================
-- 5. RLS
-- ============================================================
ALTER TABLE massivlust_ks_bilder ENABLE ROW LEVEL SECURITY;

CREATE POLICY ml_ks_bilder_org ON massivlust_ks_bilder
  FOR ALL USING (org_id = coalesce(current_setting('app.org_id', true), 'massivlust'));
