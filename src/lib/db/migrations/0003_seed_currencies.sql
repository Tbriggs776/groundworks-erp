-- ============================================================================
-- SEED CURRENCIES
-- ============================================================================
-- Global master data (not tenant-scoped). ISO-4217 codes for the most common
-- currencies Groundworks is likely to encounter. More can be added later;
-- ON CONFLICT DO NOTHING keeps this idempotent.
-- ============================================================================

INSERT INTO public.currencies (code, name, symbol, display_decimals, is_active)
VALUES
  ('USD', 'United States Dollar',    '$',   2, TRUE),
  ('CAD', 'Canadian Dollar',         'C$',  2, TRUE),
  ('EUR', 'Euro',                    '€',   2, TRUE),
  ('GBP', 'British Pound',           '£',   2, TRUE),
  ('AUD', 'Australian Dollar',       'A$',  2, TRUE),
  ('NZD', 'New Zealand Dollar',      'NZ$', 2, TRUE),
  ('MXN', 'Mexican Peso',            'Mex$',2, TRUE),
  ('JPY', 'Japanese Yen',            '¥',   0, TRUE),
  ('CNY', 'Chinese Yuan Renminbi',   '¥',   2, TRUE),
  ('CHF', 'Swiss Franc',             'CHF', 2, TRUE),
  ('SEK', 'Swedish Krona',           'kr',  2, TRUE),
  ('NOK', 'Norwegian Krone',         'kr',  2, TRUE),
  ('DKK', 'Danish Krone',            'kr',  2, TRUE)
ON CONFLICT (code) DO NOTHING;
