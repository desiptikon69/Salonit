CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth."user" (
id text PRIMARY KEY,name text NOT NULL,email text NOT NULL UNIQUE,email_verified boolean NOT NULL DEFAULT false,image text,
created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
phone_number text UNIQUE,phone_number_verified boolean DEFAULT false,role text NOT NULL DEFAULT 'client',staff_id text,client_id text
);
CREATE TABLE IF NOT EXISTS auth.session(id text PRIMARY KEY,expires_at timestamptz NOT NULL,token text UNIQUE NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),ip_address text,user_agent text,user_id text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS auth.account(id text PRIMARY KEY,account_id text NOT NULL,provider_id text NOT NULL,user_id text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,access_token text,refresh_token text,id_token text,access_token_expires_at timestamptz,refresh_token_expires_at timestamptz,scope text,password text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS auth.verification(id text PRIMARY KEY,identifier text NOT NULL,value text NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS verification_identifier_idx ON auth.verification(identifier);
CREATE TABLE IF NOT EXISTS records(id text PRIMARY KEY,kind text NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS records_kind ON records(kind);
CREATE TABLE IF NOT EXISTS appointments(
id uuid PRIMARY KEY,reference text NOT NULL UNIQUE,client_id text NOT NULL DEFAULT '',status text NOT NULL DEFAULT 'hold',
start_at timestamptz NOT NULL,end_at timestamptz NOT NULL,items jsonb NOT NULL DEFAULT '[]',
total_minor bigint NOT NULL CHECK(total_minor>=0),paid_minor bigint NOT NULL DEFAULT 0 CHECK(paid_minor>=0),
materials jsonb NOT NULL DEFAULT '[]',version integer NOT NULL DEFAULT 1,receipt_status text NOT NULL DEFAULT 'unknown',note text NOT NULL DEFAULT '',closed_at timestamptz,
hold_token_hash text,hold_phone text,hold_expires_at timestamptz,parent_id uuid REFERENCES appointments(id),created_at timestamptz NOT NULL DEFAULT now(),
CHECK(end_at>start_at),CHECK(status IN ('hold','confirmed','arrived','in_progress','completed','cancelled','no_show')));
CREATE INDEX IF NOT EXISTS appointment_date ON appointments(start_at);
CREATE TABLE IF NOT EXISTS allocations(id uuid PRIMARY KEY,appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,resource_key text NOT NULL,start_at timestamptz NOT NULL,end_at timestamptz NOT NULL,active boolean NOT NULL DEFAULT true,CHECK(end_at>start_at),EXCLUDE USING gist(resource_key WITH =,tstzrange(start_at,end_at,'[)') WITH &&) WHERE(active));
CREATE INDEX IF NOT EXISTS allocations_visit ON allocations(appointment_id);
CREATE TABLE IF NOT EXISTS payments(id uuid PRIMARY KEY,visit_id uuid REFERENCES appointments(id),method text NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor>=0),kind text NOT NULL DEFAULT 'payment',certificate_id text,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS consumptions(id uuid PRIMARY KEY,visit_id uuid NOT NULL REFERENCES appointments(id),material_id text NOT NULL,quantity_milli bigint NOT NULL CHECK(quantity_milli>=0),cost_minor bigint NOT NULL CHECK(cost_minor>=0),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(visit_id,material_id));
CREATE TABLE IF NOT EXISTS accruals(id uuid PRIMARY KEY,visit_id uuid NOT NULL REFERENCES appointments(id),staff_id text NOT NULL,service_name text NOT NULL,base_minor bigint NOT NULL,amount_minor bigint NOT NULL,rate_bps integer NOT NULL,status text NOT NULL DEFAULT 'preliminary',date date NOT NULL,rule_snapshot jsonb NOT NULL DEFAULT '{}',UNIQUE(visit_id,staff_id,service_name));
CREATE TABLE IF NOT EXISTS payouts(id uuid PRIMARY KEY,month text NOT NULL,staff_id text NOT NULL,amount_minor bigint NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(month,staff_id));
CREATE TABLE IF NOT EXISTS audit_events(id uuid PRIMARY KEY,actor text NOT NULL,action text NOT NULL,entity_id text NOT NULL,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS outbox(id uuid PRIMARY KEY,kind text NOT NULL,payload jsonb NOT NULL,status text NOT NULL DEFAULT 'pending',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS commands(id text PRIMARY KEY,actor_id text NOT NULL,action text NOT NULL,result jsonb,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS import_runs(fingerprint text PRIMARY KEY,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS demo_otp(phone text PRIMARY KEY,code text NOT NULL,expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS request_limits(key text PRIMARY KEY,count int NOT NULL,expires_at timestamptz NOT NULL);

