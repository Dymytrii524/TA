-- F05-B. Transactional migration; do not silently relabel historical withdrawals.
BEGIN;
LOCK TABLE web3.chain_events, web3.intents IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT FROM web3.chain_events WHERE event_kind IN ('Withdrawn','Settled'))
     OR EXISTS(SELECT FROM web3.intents WHERE action='withdraw') THEN
    RAISE EXCEPTION 'F05 requires reviewed backfill of settlement/withdrawal history';
  END IF;
END $$;
ALTER TABLE web3.chain_events ALTER COLUMN escrow_id DROP NOT NULL;
ALTER TABLE web3.chain_events ADD COLUMN event_scope text GENERATED ALWAYS AS
  (CASE WHEN event_kind='Withdrawn' THEN 'wallet'
        WHEN event_kind='IntakePause' THEN 'contract' ELSE 'deal' END) STORED;
ALTER TABLE web3.chain_events ADD CONSTRAINT typed_event_scope CHECK (
  (event_kind IN ('Funded','StateChanged','EvidenceSubmitted','Accepted','Disputed','Settled')
    AND escrow_id IS NOT NULL)
  OR (event_kind='Withdrawn' AND escrow_id IS NULL
    AND payload->>'account' IS NOT NULL AND payload->>'account' ~ '^0x[0-9a-f]{40}$'
    AND payload->>'amount' IS NOT NULL AND payload->>'amount' ~ '^[1-9][0-9]{0,77}$'
    AND (payload->>'amount')::numeric <= 115792089237316195423570985008687907853269984665640564039457584007913129639935)
  OR (event_kind='IntakePause' AND escrow_id IS NULL));
ALTER TABLE web3.intents ALTER COLUMN deal_id DROP NOT NULL;
ALTER TABLE web3.intents ADD COLUMN wallet_binding_id uuid REFERENCES web3.wallet_bindings;
ALTER TABLE web3.intents ADD CONSTRAINT typed_intent_scope CHECK (
  (action='withdraw' AND deal_id IS NULL AND wallet_binding_id IS NOT NULL)
  OR (action<>'withdraw' AND deal_id IS NOT NULL AND wallet_binding_id IS NULL));
CREATE UNIQUE INDEX wallet_intent_idempotency
  ON web3.intents(actor_user_id,chain_id,wallet_binding_id,action,idempotency_key)
  WHERE action='withdraw';
-- Managed by trusted TA integration, never by this HTTP API.
CREATE TABLE web3.wallet_permissions (
  user_id uuid NOT NULL REFERENCES public.users,
  company_id uuid NOT NULL REFERENCES public.companies,
  can_withdraw boolean NOT NULL DEFAULT false,
  PRIMARY KEY(user_id,company_id));
CREATE FUNCTION web3.guard_wallet_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action='withdraw' AND NEW.status='prepared' THEN
    PERFORM 1 FROM web3.wallet_bindings b JOIN web3.wallet_permissions p
      ON p.company_id=b.company_id AND p.user_id=NEW.actor_user_id
      WHERE b.id=NEW.wallet_binding_id AND b.chain_id=NEW.chain_id
        AND b.revoked_at IS NULL AND p.can_withdraw FOR SHARE OF b,p;
    IF NOT FOUND THEN RAISE EXCEPTION 'wallet authorization denied'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wallet_intent BEFORE INSERT OR UPDATE ON web3.intents
  FOR EACH ROW EXECUTE FUNCTION web3.guard_wallet_intent();
-- Immutable, versioned, complete subledger snapshots. A failed reconciliation
-- never publishes partial allocations. Monetary JSON fields are decimal strings.
CREATE TABLE web3.wallet_reconciliations (
  id uuid PRIMARY KEY,
  chain_id bigint NOT NULL REFERENCES web3.networks,
  contract_address web3.address NOT NULL,
  token_address web3.address NOT NULL,
  block_number bigint NOT NULL CHECK(block_number>=0),
  block_hash web3.hash NOT NULL,
  policy_version text NOT NULL CHECK(policy_version='F05-B/1'),
  subledger jsonb NOT NULL CHECK(jsonb_typeof(subledger)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(chain_id,contract_address,block_hash));
CREATE TRIGGER wallet_reconciliation_immutable BEFORE UPDATE OR DELETE
  ON web3.wallet_reconciliations FOR EACH ROW EXECUTE FUNCTION web3.no_mutation();
CREATE TRIGGER wallet_reconciliation_no_truncate BEFORE TRUNCATE
  ON web3.wallet_reconciliations FOR EACH STATEMENT EXECUTE FUNCTION web3.no_mutation();
REVOKE ALL ON web3.wallet_permissions,web3.wallet_reconciliations FROM PUBLIC;
COMMIT;
