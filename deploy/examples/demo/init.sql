-- SPDX-License-Identifier: Elastic-2.0
-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

-- Throwaway demo data for the quickstart. The Postgres image runs this on FIRST
-- boot only: an existing `postgres-data` volume is never re-initialised, so a
-- stack that predates this file needs `docker compose down -v` once to pick it up.
--
-- Everything below is invented - two fake names, ten fake support tickets, no
-- customer data and no personal data. It exists so that
-- `flows/04-tool-use-with-approval.yaml` has something governed to read and write.
--
-- The `demo` schema is deliberately separate from the tables the Search service
-- creates in the same database, so this can never collide with a real index.
CREATE SCHEMA IF NOT EXISTS demo;

CREATE TABLE IF NOT EXISTS demo.tickets (
    id         serial      PRIMARY KEY,
    owner      text        NOT NULL,
    subject    text        NOT NULL,
    status     text        NOT NULL DEFAULT 'open',
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Two invented identities. `ticket_lookup` filters on the CALLER'S verified
-- identity (`:ctx.username`), never on a name the model was told, so a caller
-- sees its own rows and nothing else. The quickstart's local token identifies as
-- `anja.weiss`, which makes the missing `sam.rivers` rows the actual
-- demonstration: row-level scoping is enforced in the tool, not in the prompt.
INSERT INTO demo.tickets (owner, subject, status, created_at) VALUES
    ('anja.weiss', 'Badge reader on floor 3 rejects my card',        'open',        now() - interval '5 hours'),
    ('anja.weiss', 'Laser printer down the hall prints mirrored',    'resolved',    now() - interval '9 days'),
    ('anja.weiss', 'VPN drops every night around 18:00',             'in_progress', now() - interval '2 days'),
    ('anja.weiss', 'Request: second monitor for home office',        'open',        now() - interval '26 hours'),
    ('anja.weiss', 'Calendar invites arrive 40 minutes late',        'resolved',    now() - interval '3 weeks'),
    ('anja.weiss', 'Notebook fan runs at full speed when idle',      'open',        now() - interval '71 hours'),
    ('sam.rivers', 'Shared drive folder is read-only for my team',   'open',        now() - interval '8 hours'),
    ('sam.rivers', 'Invoice PDFs are missing the new logo',          'in_progress', now() - interval '4 days'),
    ('sam.rivers', 'Meeting room booking e-mail never arrives',      'resolved',    now() - interval '12 days'),
    ('sam.rivers', 'Reset the password for the archive account',     'open',        now() - interval '31 hours');
