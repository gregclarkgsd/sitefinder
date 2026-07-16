create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- The production cron job and its authentication token are installed
-- operationally so no sync credentials are committed to source control.
