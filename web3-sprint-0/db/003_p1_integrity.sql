-- Apply after 001 and 002, before any freeze or chain ingestion.
-- Never infer historical frozen terms from mutable current records.
BEGIN;
LOCK TABLE web3.deal_terms, web3.escrows, web3.chain_events IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT FROM web3.deal_terms) OR EXISTS(SELECT FROM web3.escrows)
     OR EXISTS(SELECT FROM web3.chain_events) THEN
    RAISE EXCEPTION 'P1 migration requires empty terms/projections/events; reviewed historical backfill required';
  END IF;
END $$;

-- Identity/challenge fields are append-only. Revocation is one-way.
CREATE FUNCTION web3.guard_binding_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'binding history is immutable'; END IF;
  IF (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at')
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'binding identity is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER binding_identity BEFORE UPDATE OR DELETE ON web3.wallet_bindings
  FOR EACH ROW EXECUTE FUNCTION web3.guard_binding_identity();

ALTER TABLE web3.deal_terms
  ADD COLUMN escrow_nonce web3.hash NOT NULL CHECK(escrow_nonce<>'0x0000000000000000000000000000000000000000000000000000000000000000'),
  ADD COLUMN terms_hash web3.hash NOT NULL,
  ADD COLUMN payer_address web3.address NOT NULL,
  ADD COLUMN carrier_address web3.address NOT NULL,
  ADD COLUMN escrow_address web3.address NOT NULL,
  ADD COLUMN token_address web3.address NOT NULL,
  ADD COLUMN token_decimals smallint NOT NULL CHECK(token_decimals=6),
  ADD COLUMN commercial_snapshot jsonb NOT NULL,
  ADD CONSTRAINT whole_second_deadlines CHECK(
    accept_by=date_trunc('second',accept_by) AND delivery_by=date_trunc('second',delivery_by)),
  ADD CONSTRAINT unique_payer_nonce UNIQUE(chain_id,escrow_address,payer_address,escrow_nonce);

CREATE FUNCTION web3.freeze_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d web3.deals; p web3.wallet_bindings; c web3.wallet_bindings; n web3.networks;
BEGIN
  -- Locks serialize freeze against concurrent source updates/revocation.
  SELECT * INTO STRICT d FROM web3.deals WHERE id=NEW.deal_id FOR SHARE;
  PERFORM 1 FROM web3.wallet_bindings
    WHERE id IN (NEW.payer_binding_id,NEW.carrier_binding_id) ORDER BY id FOR SHARE;
  SELECT * INTO STRICT p FROM web3.wallet_bindings WHERE id=NEW.payer_binding_id;
  SELECT * INTO STRICT c FROM web3.wallet_bindings WHERE id=NEW.carrier_binding_id;
  SELECT * INTO STRICT n FROM web3.networks WHERE chain_id=NEW.chain_id FOR SHARE;
  IF p.revoked_at IS NOT NULL OR c.revoked_at IS NOT NULL
     OR p.chain_id<>NEW.chain_id OR c.chain_id<>NEW.chain_id
     OR p.company_id<>d.payer_company_id OR c.company_id<>d.carrier_company_id
     OR p.wallet_address=c.wallet_address THEN
    RAISE EXCEPTION 'invalid active party bindings';
  END IF;
  NEW.frozen_at:=transaction_timestamp();
  NEW.payer_address:=p.wallet_address;
  NEW.carrier_address:=c.wallet_address;
  NEW.escrow_address:=n.escrow_address;
  NEW.token_address:=n.token_address;
  NEW.token_decimals:=n.token_decimals;
  -- Store values, not only mutable foreign keys; callers cannot forge this snapshot.
  NEW.commercial_snapshot:=to_jsonb(d)-'id'-'created_at';
  RETURN NEW;
END $$;
CREATE TRIGGER freeze_snapshot BEFORE INSERT ON web3.deal_terms
  FOR EACH ROW EXECUTE FUNCTION web3.freeze_snapshot();

CREATE FUNCTION web3.guard_create_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t web3.deal_terms;
BEGIN
  IF NEW.action='create' AND NEW.status='prepared' THEN
    SELECT * INTO STRICT t FROM web3.deal_terms WHERE deal_id=NEW.deal_id;
    PERFORM 1 FROM web3.wallet_bindings WHERE id IN (t.payer_binding_id,t.carrier_binding_id)
      ORDER BY id FOR SHARE;
    IF NEW.chain_id<>t.chain_id OR EXISTS(
      SELECT FROM web3.wallet_bindings WHERE id IN (t.payer_binding_id,t.carrier_binding_id)
        AND revoked_at IS NOT NULL) THEN
      RAISE EXCEPTION 'create intent requires active frozen bindings on same chain';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER create_intent BEFORE INSERT OR UPDATE ON web3.intents
  FOR EACH ROW EXECUTE FUNCTION web3.guard_create_intent();

ALTER TABLE web3.escrows
  ADD COLUMN funding_event_id uuid NOT NULL REFERENCES web3.chain_events(id);
CREATE FUNCTION web3.guard_funding_terms() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t web3.deal_terms; f web3.chain_events; s web3.chain_events;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'escrow projection cannot be deleted'; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.funding_event_id IS DISTINCT FROM OLD.funding_event_id THEN
      RAISE EXCEPTION 'funding evidence is immutable';
    END IF;
    RETURN NEW; -- existing guard_projection enforces immutable terms and transitions
  END IF;
  SELECT * INTO STRICT t FROM web3.deal_terms WHERE deal_id=NEW.deal_id;
  IF ROW(NEW.chain_id,NEW.escrow_id,NEW.payer_address,NEW.carrier_address,
         NEW.amount_atomic,NEW.terms_hash,NEW.accept_by,NEW.delivery_by)
     IS DISTINCT FROM
     ROW(t.chain_id,t.escrow_id,t.payer_address,t.carrier_address,
         t.amount_atomic,t.terms_hash,t.accept_by,t.delivery_by) THEN
    RAISE EXCEPTION 'projection differs from frozen terms';
  END IF;
  PERFORM web3.assert_final_event(NEW.funding_event_id);
  PERFORM web3.assert_final_event(NEW.last_event_id);
  SELECT * INTO STRICT f FROM web3.chain_events WHERE id=NEW.funding_event_id;
  SELECT * INTO STRICT s FROM web3.chain_events WHERE id=NEW.last_event_id;
  -- The contract emits Funded immediately followed by StateChanged(Funded).
  IF f.event_kind<>'Funded' OR s.event_kind<>'StateChanged'
     OR s.payload->>'state' IS DISTINCT FROM 'FUNDED'
     OR ROW(f.chain_id,f.tx_hash,f.block_hash,f.contract_address,f.escrow_id)
       IS DISTINCT FROM ROW(s.chain_id,s.tx_hash,s.block_hash,s.contract_address,s.escrow_id)
     OR f.chain_id<>t.chain_id OR f.contract_address<>t.escrow_address
     OR f.escrow_id<>t.escrow_id OR s.log_index<>f.log_index+1
     OR f.payload->>'payer' IS DISTINCT FROM t.payer_address::text
     OR f.payload->>'carrier' IS DISTINCT FROM t.carrier_address::text
     OR f.payload->>'amount' IS DISTINCT FROM t.amount_atomic::text
     OR f.payload->>'termsHash' IS DISTINCT FROM t.terms_hash::text THEN
    RAISE EXCEPTION 'funding event differs from frozen terms or state event';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER funding_terms BEFORE INSERT OR UPDATE OR DELETE ON web3.escrows
  FOR EACH ROW EXECUTE FUNCTION web3.guard_funding_terms();
-- Also reject TRUNCATE for ordinary DML/table-owner callers; superuser DDL is outside trust boundary.
CREATE TRIGGER escrow_no_truncate BEFORE TRUNCATE ON web3.escrows
  FOR EACH STATEMENT EXECUTE FUNCTION web3.no_mutation();
CREATE TRIGGER terms_no_truncate BEFORE TRUNCATE ON web3.deal_terms
  FOR EACH STATEMENT EXECUTE FUNCTION web3.no_mutation();
COMMIT;
