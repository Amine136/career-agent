-- Seed the 12 target markets. Idempotent upsert.
insert into countries (id, name, flag, indeed_domain, linkedin_location, languages, priority, enabled) values
  ('DE', 'Germany',        '🇩🇪', 'de.indeed.com', 'Germany',                 '{de,en}', 1,  true),
  ('CA', 'Canada',         '🇨🇦', 'ca.indeed.com', 'Canada',                  '{en,fr}', 2,  true),
  ('AU', 'Australia',      '🇦🇺', 'au.indeed.com', 'Australia',               '{en}',    3,  true),
  ('NL', 'Netherlands',    '🇳🇱', 'nl.indeed.com', 'Netherlands',             '{nl,en}', 4,  true),
  ('IE', 'Ireland',        '🇮🇪', 'ie.indeed.com', 'Ireland',                 '{en}',    5,  true),
  ('SG', 'Singapore',      '🇸🇬', 'sg.indeed.com', 'Singapore',               '{en}',    6,  true),
  ('AE', 'UAE',            '🇦🇪', 'ae.indeed.com', 'United Arab Emirates',    '{en,ar}', 7,  true),
  ('SE', 'Sweden',         '🇸🇪', 'se.indeed.com', 'Sweden',                  '{sv,en}', 8,  true),
  ('GB', 'United Kingdom', '🇬🇧', 'uk.indeed.com', 'United Kingdom',          '{en}',    9,  true),
  ('SA', 'Saudi Arabia',   '🇸🇦', 'sa.indeed.com', 'Saudi Arabia',            '{ar,en}', 10, true),
  ('QA', 'Qatar',          '🇶🇦', 'qa.indeed.com', 'Qatar',                   '{ar,en}', 11, true),
  ('MY', 'Malaysia',       '🇲🇾', 'my.indeed.com', 'Malaysia',                '{en,ms}', 12, true)
on conflict (id) do update set
  name              = excluded.name,
  flag              = excluded.flag,
  indeed_domain     = excluded.indeed_domain,
  linkedin_location = excluded.linkedin_location,
  languages         = excluded.languages,
  priority          = excluded.priority,
  enabled           = excluded.enabled,
  updated_at        = now();
