-- Local/Amoy pilot. Run with a migration owner, never with the runtime role.
BEGIN;
CREATE SCHEMA web3;
CREATE DOMAIN web3.address AS text CHECK (VALUE ~ '^0x[0-9a-f]{40}$');
CREATE DOMAIN web3.hash AS text CHECK (VALUE ~ '^0x[0-9a-f]{64}$');
-- No typmod rounding: fractional input must be rejected, never silently rounded.
CREATE DOMAIN web3.uint256 AS numeric CHECK (
  VALUE = trunc(VALUE) AND VALUE >= 0 AND
  VALUE <= 115792089237316195423570985008687907853269984665640564039457584007913129639935
);
CREATE TYPE web3.escrow_state AS ENUM ('FUNDED','ACTIVE','DELIVERED','ACCEPTED','DISPUTED','SETTLED');
CREATE TYPE web3.tx_state AS ENUM ('submitted','included','finalized','failed','orphaned');
CREATE TABLE web3.networks (
  chain_id bigint PRIMARY KEY CHECK (chain_id IN (31337,80002)),
  token_address web3.address NOT NULL,
  token_decimals smallint NOT NULL CHECK (token_decimals=6),
  escrow_address web3.address NOT NULL,
  deployment_block bigint NOT NULL CHECK (deployment_block>=0),
  code_hash web3.hash NOT NULL,
  CHECK (chain_id<>80002 OR token_address='0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582')
);
CREATE TABLE web3.wallet_bindings (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  verified_by_user_id uuid NOT NULL,
  chain_id bigint NOT NULL REFERENCES web3.networks,
  wallet_address web3.address NOT NULL,
  challenge_hash web3.hash NOT NULL UNIQUE,
  verified_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (revoked_at IS NULL OR revoked_at>=verified_at)
);
CREATE UNIQUE INDEX one_active_wallet ON web3.wallet_bindings(chain_id,wallet_address) WHERE revoked_at IS NULL;
CREATE TABLE web3.deals (
  id uuid PRIMARY KEY,
  payer_company_id uuid NOT NULL,
  carrier_company_id uuid NOT NULL,
  price_amount numeric NOT NULL CHECK (price_amount>0 AND price_amount=round(price_amount,2)),
  price_currency text NOT NULL CHECK (price_currency ~ '^[A-Z]{3}$'),
  contract_currency text NOT NULL CHECK (contract_currency ~ '^[A-Z]{3}$'),
  fx_rate numeric NOT NULL CHECK (fx_rate>0),
  fx_source text NOT NULL CHECK (length(fx_source)>0),
  fx_fixed_at timestamptz NOT NULL,
  fx_expires_at timestamptz NOT NULL,
  agreement_commitment web3.hash NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (payer_company_id<>carrier_company_id),
  CHECK (fx_expires_at>fx_fixed_at)
);
CREATE TABLE web3.intents (
  id uuid PRIMARY KEY,
  deal_id uuid NOT NULL REFERENCES web3.deals,
  actor_user_id uuid NOT NULL,
  chain_id bigint NOT NULL REFERENCES web3.networks,
  action text NOT NULL CHECK(action IN ('create','accept','cancelUnaccepted','submitDelivery',
    'approveDelivery','dispute','escalateOverdue','finalize','resolve','withdraw')),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 16 AND 128),
  request_hash web3.hash NOT NULL,
  status text NOT NULL CHECK(status IN ('prepared','submitted','confirmed','expired','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE(actor_user_id,deal_id,action,idempotency_key),
  CHECK(expires_at>created_at)
);
-- Frozen pre-funding terms consumed by prepareEscrowIntent(create).
CREATE TABLE web3.deal_terms (
  deal_id uuid PRIMARY KEY REFERENCES web3.deals,
  chain_id bigint NOT NULL REFERENCES web3.networks,
  escrow_id web3.hash NOT NULL,
  payer_binding_id uuid NOT NULL REFERENCES web3.wallet_bindings,
  carrier_binding_id uuid NOT NULL REFERENCES web3.wallet_bindings,
  amount_atomic web3.uint256 NOT NULL CHECK(amount_atomic>0),
  accept_by timestamptz NOT NULL,
  delivery_by timestamptz NOT NULL,
  frozen_at timestamptz NOT NULL,
  UNIQUE(chain_id,escrow_id),
  CHECK(payer_binding_id<>carrier_binding_id),
  CHECK(accept_by>frozen_at AND delivery_by>accept_by)
);
CREATE TABLE web3.chain_transactions (
  chain_id bigint NOT NULL REFERENCES web3.networks,
  tx_hash web3.hash NOT NULL,
  state web3.tx_state NOT NULL,
  block_hash web3.hash,
  block_number bigint CHECK(block_number>=0),
  receipt_success boolean,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(chain_id,tx_hash),
  CHECK(state NOT IN ('included','finalized') OR
    (block_hash IS NOT NULL AND block_number IS NOT NULL AND receipt_success IS TRUE)),
  CHECK(state<>'failed' OR receipt_success IS FALSE)
);
CREATE TABLE web3.intent_transactions (
  intent_id uuid NOT NULL REFERENCES web3.intents,
  chain_id bigint NOT NULL,
  tx_hash web3.hash NOT NULL,
  PRIMARY KEY(intent_id,chain_id,tx_hash),
  UNIQUE(chain_id,tx_hash),
  FOREIGN KEY(chain_id,tx_hash) REFERENCES web3.chain_transactions
);
CREATE TABLE web3.chain_events (
  id uuid PRIMARY KEY,
  chain_id bigint NOT NULL,
  tx_hash web3.hash NOT NULL,
  block_hash web3.hash NOT NULL,
  log_index integer NOT NULL CHECK(log_index>=0),
  contract_address web3.address NOT NULL,
  escrow_id web3.hash NOT NULL,
  event_kind text NOT NULL,
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  finalized boolean NOT NULL DEFAULT false,
  FOREIGN KEY(chain_id,tx_hash) REFERENCES web3.chain_transactions,
  UNIQUE(chain_id,block_hash,tx_hash,log_index)
);
CREATE TABLE web3.escrows (
  deal_id uuid PRIMARY KEY REFERENCES web3.deals,
  chain_id bigint NOT NULL REFERENCES web3.networks,
  escrow_id web3.hash NOT NULL,
  payer_address web3.address NOT NULL,
  carrier_address web3.address NOT NULL,
  amount_atomic web3.uint256 NOT NULL CHECK(amount_atomic>0),
  terms_hash web3.hash NOT NULL,
  accept_by timestamptz NOT NULL,
  delivery_by timestamptz NOT NULL,
  release_at timestamptz,
  state web3.escrow_state NOT NULL,
  last_event_id uuid NOT NULL REFERENCES web3.chain_events,
  UNIQUE(chain_id,escrow_id),
  CHECK(payer_address<>carrier_address),
  CHECK(delivery_by>accept_by),
  CHECK(state<>'ACCEPTED' OR release_at IS NOT NULL)
);
CREATE TABLE web3.evidence (
  id uuid PRIMARY KEY,
  deal_id uuid NOT NULL REFERENCES web3.deals,
  uploaded_by_user_id uuid NOT NULL,
  private_object_key text NOT NULL CHECK(length(private_object_key)>0),
  commitment web3.hash NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE web3.outbox (
  id uuid PRIMARY KEY,
  intent_id uuid NOT NULL UNIQUE REFERENCES web3.intents,
  topic text NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  available_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
-- Balanced double-entry test journal in atomic units, no fiat conversion here.
CREATE TABLE web3.ledger_entries (
  operation_id uuid NOT NULL,
  line_no smallint NOT NULL CHECK(line_no>0),
  event_id uuid NOT NULL REFERENCES web3.chain_events,
  account text NOT NULL,
  amount_atomic numeric NOT NULL CHECK(amount_atomic<>0 AND amount_atomic=trunc(amount_atomic)),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(operation_id,line_no),
  UNIQUE(event_id,account)
);
CREATE FUNCTION web3.assert_final_event(event_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE ev web3.chain_events; tx web3.chain_transactions; net web3.networks;
BEGIN
  SELECT * INTO STRICT ev FROM web3.chain_events WHERE id=event_id;
  SELECT * INTO STRICT tx FROM web3.chain_transactions WHERE chain_id=ev.chain_id AND tx_hash=ev.tx_hash;
  SELECT * INTO STRICT net FROM web3.networks WHERE chain_id=ev.chain_id;
  IF NOT ev.finalized OR tx.state<>'finalized' OR tx.receipt_success IS NOT TRUE
     OR tx.block_hash<>ev.block_hash OR net.escrow_address<>ev.contract_address THEN
    RAISE EXCEPTION 'unverified chain event';
  END IF;
END $$;
CREATE FUNCTION web3.guard_projection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ev web3.chain_events;
BEGIN
  PERFORM web3.assert_final_event(NEW.last_event_id);
  SELECT * INTO STRICT ev FROM web3.chain_events WHERE id=NEW.last_event_id;
  IF ev.chain_id<>NEW.chain_id OR ev.escrow_id<>NEW.escrow_id OR ev.event_kind<>'StateChanged'
    OR ev.payload->>'state' IS DISTINCT FROM NEW.state::text THEN
    RAISE EXCEPTION 'event does not match projection';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'FUNDED' THEN RAISE EXCEPTION 'initial state must be FUNDED'; END IF;
  ELSE
    IF ROW(NEW.deal_id,NEW.chain_id,NEW.escrow_id,NEW.payer_address,NEW.carrier_address,
      NEW.amount_atomic,NEW.terms_hash,NEW.accept_by,NEW.delivery_by)
      IS DISTINCT FROM ROW(OLD.deal_id,OLD.chain_id,OLD.escrow_id,OLD.payer_address,OLD.carrier_address,
      OLD.amount_atomic,OLD.terms_hash,OLD.accept_by,OLD.delivery_by) THEN
      RAISE EXCEPTION 'immutable escrow terms';
    END IF;
    IF NOT ((OLD.state='FUNDED' AND NEW.state IN ('ACTIVE','SETTLED'))
      OR (OLD.state='ACTIVE' AND NEW.state IN ('DELIVERED','DISPUTED'))
      OR (OLD.state='DELIVERED' AND NEW.state IN ('ACCEPTED','DISPUTED'))
      OR (OLD.state='ACCEPTED' AND NEW.state IN ('SETTLED','DISPUTED'))
      OR (OLD.state='DISPUTED' AND NEW.state='SETTLED')) THEN
      RAISE EXCEPTION 'illegal state transition';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_projection BEFORE INSERT OR UPDATE ON web3.escrows
  FOR EACH ROW EXECUTE FUNCTION web3.guard_projection();
CREATE FUNCTION web3.no_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'append-only'; END $$;
CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON web3.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION web3.no_mutation();
CREATE TRIGGER evidence_immutable BEFORE UPDATE OR DELETE ON web3.evidence
  FOR EACH ROW EXECUTE FUNCTION web3.no_mutation();
CREATE TRIGGER network_immutable BEFORE UPDATE OR DELETE ON web3.networks
  FOR EACH ROW EXECUTE FUNCTION web3.no_mutation();
CREATE TRIGGER terms_immutable BEFORE UPDATE OR DELETE ON web3.deal_terms
  FOR EACH ROW EXECUTE FUNCTION web3.no_mutation();
CREATE FUNCTION web3.guard_finality() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='chain_transactions' THEN
    IF OLD.state='finalized' THEN RAISE EXCEPTION 'finality breach: halt reconciliation'; END IF;
  ELSE
    IF OLD.finalized THEN RAISE EXCEPTION 'finalized event is immutable'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER transaction_finality BEFORE UPDATE OR DELETE ON web3.chain_transactions
  FOR EACH ROW EXECUTE FUNCTION web3.guard_finality();
CREATE TRIGGER event_finality BEFORE UPDATE OR DELETE ON web3.chain_events
  FOR EACH ROW EXECUTE FUNCTION web3.guard_finality();
CREATE FUNCTION web3.check_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE balance numeric; event_count bigint;
BEGIN
  PERFORM web3.assert_final_event(NEW.event_id);
  SELECT sum(amount_atomic),count(DISTINCT event_id) INTO balance,event_count
    FROM web3.ledger_entries WHERE operation_id=NEW.operation_id;
  IF balance<>0 OR event_count<>1 THEN RAISE EXCEPTION 'unbalanced or mixed-event journal'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_balanced AFTER INSERT ON web3.ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION web3.check_ledger();
-- Runtime privileges must be granted separately and narrowly; never grant DDL.
REVOKE ALL ON ALL TABLES IN SCHEMA web3 FROM PUBLIC;
COMMIT;
