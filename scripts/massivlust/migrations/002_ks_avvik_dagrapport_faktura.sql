-- Massivlust: KS, avvik, dagrapporter, fakturering
-- Dato: 2026-05-02
-- Ref: Alex brain-dump del 7-9 + prosjektperm-PDFer

-- Utvid prosjekt-tabellen
ALTER TABLE massivlust_projects
  ADD COLUMN IF NOT EXISTS leverandor TEXT,
  ADD COLUMN IF NOT EXISTS leverandor_kontakt TEXT,
  ADD COLUMN IF NOT EXISTS leverandor_pl TEXT,
  ADD COLUMN IF NOT EXISTS faktureringsplan JSONB DEFAULT '[]'::jsonb;

-- KS-entries per område/element
CREATE TABLE IF NOT EXISTS massivlust_ks_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES massivlust_projects(id) ON DELETE CASCADE,
  omraade TEXT NOT NULL,
  element_ids TEXT[],
  status TEXT DEFAULT 'pending' CHECK (status IN (
    'pending', 'in_progress', 'done', 'signed_montor', 'signed_pl'
  )),
  montor_navn TEXT,
  montor_signert_dato TIMESTAMPTZ,
  pl_signert_dato TIMESTAMPTZ,
  foto_urls TEXT[],
  kommentar TEXT,
  sjekkliste_punkt TEXT,
  org_id TEXT DEFAULT 'massivlust' NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Avvik
CREATE TABLE IF NOT EXISTS massivlust_avvik (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES massivlust_projects(id) ON DELETE CASCADE,
  avvik_nr INTEGER NOT NULL,
  dato DATE NOT NULL DEFAULT CURRENT_DATE,
  montor_navn TEXT NOT NULL,
  beskrivelse TEXT NOT NULL,
  foto_urls TEXT[],
  sendt_til TEXT,
  leverandor TEXT,
  status TEXT DEFAULT 'aapen' CHECK (status IN ('aapen', 'under_arbeid', 'lukket')),
  plan_for_lukking TEXT,
  lukket_dato DATE,
  lukket_av TEXT,
  org_id TEXT DEFAULT 'massivlust' NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, avvik_nr)
);

-- Dagrapporter
CREATE TABLE IF NOT EXISTS massivlust_dagrapporter (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES massivlust_projects(id) ON DELETE SET NULL,
  montor_navn TEXT NOT NULL,
  dato DATE NOT NULL DEFAULT CURRENT_DATE,
  utfort TEXT,
  elementer TEXT,
  lukkes TEXT,
  retro_bra TEXT,
  retro_daarlig TEXT,
  tiltak TEXT,
  nye_avvik TEXT,
  timer_rapportert NUMERIC(4,1),
  timer_tripletex NUMERIC(4,1),
  timer_match BOOLEAN,
  kilde TEXT DEFAULT 'telegram' CHECK (kilde IN ('telegram', 'voice', 'manual')),
  org_id TEXT DEFAULT 'massivlust' NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, montor_navn, dato)
);

-- Fakturaer / milepæl-fakturering
CREATE TABLE IF NOT EXISTS massivlust_fakturaer (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES massivlust_projects(id) ON DELETE CASCADE,
  milepael TEXT NOT NULL,
  belop_nok NUMERIC,
  status TEXT DEFAULT 'planlagt' CHECK (status IN ('planlagt', 'sendt', 'betalt', 'forfalt')),
  forfallsdato DATE,
  sendt_dato DATE,
  betalt_dato DATE,
  tripletex_ref TEXT,
  org_id TEXT DEFAULT 'massivlust' NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indekser
CREATE INDEX IF NOT EXISTS idx_ml_ks_project ON massivlust_ks_entries(project_id);
CREATE INDEX IF NOT EXISTS idx_ml_ks_status ON massivlust_ks_entries(status);
CREATE INDEX IF NOT EXISTS idx_ml_avvik_project ON massivlust_avvik(project_id);
CREATE INDEX IF NOT EXISTS idx_ml_avvik_status ON massivlust_avvik(status);
CREATE INDEX IF NOT EXISTS idx_ml_dagrapport_dato ON massivlust_dagrapporter(dato);
CREATE INDEX IF NOT EXISTS idx_ml_dagrapport_project ON massivlust_dagrapporter(project_id);
CREATE INDEX IF NOT EXISTS idx_ml_faktura_project ON massivlust_fakturaer(project_id);
CREATE INDEX IF NOT EXISTS idx_ml_faktura_status ON massivlust_fakturaer(status);

-- RLS
ALTER TABLE massivlust_ks_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE massivlust_avvik ENABLE ROW LEVEL SECURITY;
ALTER TABLE massivlust_dagrapporter ENABLE ROW LEVEL SECURITY;
ALTER TABLE massivlust_fakturaer ENABLE ROW LEVEL SECURITY;

CREATE POLICY ml_ks_org ON massivlust_ks_entries
  FOR ALL USING (org_id = coalesce(current_setting('app.org_id', true), 'massivlust'));

CREATE POLICY ml_avvik_org ON massivlust_avvik
  FOR ALL USING (org_id = coalesce(current_setting('app.org_id', true), 'massivlust'));

CREATE POLICY ml_dagrapport_org ON massivlust_dagrapporter
  FOR ALL USING (org_id = coalesce(current_setting('app.org_id', true), 'massivlust'));

CREATE POLICY ml_faktura_org ON massivlust_fakturaer
  FOR ALL USING (org_id = coalesce(current_setting('app.org_id', true), 'massivlust'));
