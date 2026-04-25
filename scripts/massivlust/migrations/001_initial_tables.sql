-- Massivlust AI-system: initielle tabeller
-- Org: massivlust (RLS-isolert fra westside-hq)
-- Dato: 2026-04-24

-- Prosjekter
CREATE TABLE IF NOT EXISTS massivlust_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  address TEXT,
  customer TEXT,
  customer_contact TEXT,
  contract_type TEXT CHECK (contract_type IN ('NS8405', 'NS8406', 'NS8407', 'other')),
  lifecycle_phase TEXT DEFAULT 'lead' CHECK (lifecycle_phase IN (
    'lead', 'tilbud', 'kontrakt', 'prosjektering', 'ressursmote',
    'ankomst', 'kapasitet_sjekk', 'tidspunkt', 'mandagsmoter',
    'montasje', 'fullfort', 'dokumentasjon'
  )),
  start_date DATE,
  end_date DATE,
  capacity_needed INTEGER,
  budget_nok NUMERIC,
  revenue_nok NUMERIC,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  notes TEXT,
  org_id TEXT DEFAULT 'massivlust' NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Kapasitet / tilgjengelighet per person
CREATE TABLE IF NOT EXISTS massivlust_availability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_name TEXT NOT NULL,
  person_email TEXT,
  person_role TEXT CHECK (person_role IN ('montor', 'montasjeleder', 'prosjektleder', 'controller')),
  project_id UUID REFERENCES massivlust_projects(id) ON DELETE SET NULL,
  date_start DATE NOT NULL,
  date_end DATE NOT NULL,
  available BOOLEAN DEFAULT true,
  notes TEXT,
  source TEXT DEFAULT 'manual' CHECK (source IN ('calendar', 'self-update', 'system', 'manual')),
  org_id TEXT DEFAULT 'massivlust' NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indekser
CREATE INDEX IF NOT EXISTS idx_ml_avail_person ON massivlust_availability(person_name);
CREATE INDEX IF NOT EXISTS idx_ml_avail_dates ON massivlust_availability(date_start, date_end);
CREATE INDEX IF NOT EXISTS idx_ml_avail_org ON massivlust_availability(org_id);
CREATE INDEX IF NOT EXISTS idx_ml_proj_status ON massivlust_projects(status);
CREATE INDEX IF NOT EXISTS idx_ml_proj_lifecycle ON massivlust_projects(lifecycle_phase);
CREATE INDEX IF NOT EXISTS idx_ml_proj_org ON massivlust_projects(org_id);

-- RLS
ALTER TABLE massivlust_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE massivlust_availability ENABLE ROW LEVEL SECURITY;

CREATE POLICY ml_projects_org_isolation ON massivlust_projects
  FOR ALL USING (
    org_id = coalesce(current_setting('app.org_id', true), 'massivlust')
  );

CREATE POLICY ml_availability_org_isolation ON massivlust_availability
  FOR ALL USING (
    org_id = coalesce(current_setting('app.org_id', true), 'massivlust')
  );

-- Seed: Verksgata 54
INSERT INTO massivlust_projects (name, address, customer, customer_contact, contract_type, lifecycle_phase, status, notes)
VALUES (
  'Verksgata 54',
  'Verksgata 54, Stavanger',
  'Massivtre AS',
  'Christian Oien Danielsen (tlf 45973106)',
  'NS8406',
  'montasje',
  'active',
  'Pilot-prosjekt for AI-systemet. Grunnarbeid + betong + montasje.'
);

-- Seed: 6 ansatte tilgjengelighet uke 18-19 (2026-04-27 til 2026-05-10)
INSERT INTO massivlust_availability (person_name, person_email, person_role, date_start, date_end, available, source, notes) VALUES
  ('Alex Lien', 'alex@massivlust.no', 'controller', '2026-04-27', '2026-05-10', true, 'manual', 'Tilgjengelig hele perioden'),
  ('Vegard', NULL, 'montor', '2026-04-27', '2026-05-03', true, 'manual', 'Ledig uke 18'),
  ('Vegard', NULL, 'montor', '2026-05-04', '2026-05-10', true, 'manual', 'Ledig uke 19'),
  ('Martin', NULL, 'montor', '2026-04-27', '2026-05-03', true, 'manual', 'Ledig uke 18'),
  ('Martin', NULL, 'montor', '2026-05-04', '2026-05-10', false, 'manual', 'Ikke tilgjengelig uke 19'),
  ('Mathias Ronnestad', 'mathias@massivlust.no', 'montasjeleder', '2026-04-27', '2026-05-10', true, 'manual', 'Alltid tilgjengelig'),
  ('Eivind Smedal', 'eivind.smedal@outlook.com', 'montor', '2026-04-27', '2026-05-03', true, 'manual', 'Ledig uke 18'),
  ('Eivind Smedal', 'eivind.smedal@outlook.com', 'montor', '2026-05-04', '2026-05-07', true, 'manual', 'Ledig man-ons uke 19'),
  ('Eivind Smedal', 'eivind.smedal@outlook.com', 'montor', '2026-05-08', '2026-05-10', false, 'manual', 'Syk thu-fri uke 19'),
  ('Odin Austefjord', 'odin-a@hotmail.com', 'montor', '2026-05-04', '2026-05-10', true, 'manual', 'Tilgjengelig mai');
