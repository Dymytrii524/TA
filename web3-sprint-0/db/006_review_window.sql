-- F07-A / terms V2. Never reinterpret existing frozen/on-chain terms.
BEGIN;
LOCK TABLE web3.deal_terms,web3.escrows,web3.chain_events,web3.intents IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT FROM web3.deal_terms) OR EXISTS(SELECT FROM web3.escrows)
    OR EXISTS(SELECT FROM web3.chain_events)
    OR EXISTS(SELECT FROM web3.intents WHERE status IN ('prepared','submitted')) THEN
    RAISE EXCEPTION 'F07 V2 requires empty frozen history and no live intents; separate reviewed version migration required';
  END IF;
END $$;
ALTER TABLE web3.deal_terms
  ADD COLUMN terms_version smallint NOT NULL DEFAULT 2 CHECK(terms_version=2),
  ADD COLUMN review_period_seconds integer NOT NULL DEFAULT 172800 CHECK(review_period_seconds=172800);
ALTER TABLE web3.escrows
  ADD COLUMN delivery_submitted_at timestamptz,
  ADD COLUMN review_by timestamptz,
  ADD COLUMN review_period_seconds integer NOT NULL DEFAULT 172800 CHECK(review_period_seconds=172800),
  ADD CONSTRAINT review_clock CHECK (
    (delivery_submitted_at IS NULL AND review_by IS NULL AND state NOT IN ('DELIVERED','ACCEPTED'))
    OR (delivery_submitted_at IS NOT NULL AND review_by IS NOT NULL
      AND isfinite(delivery_submitted_at) AND isfinite(review_by)
      AND delivery_submitted_at=date_trunc('second',delivery_submitted_at)
      AND delivery_submitted_at<=delivery_by
      AND review_by=delivery_submitted_at+interval '48 hours'));
CREATE FUNCTION web3.guard_review_clock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st web3.chain_events; ev web3.chain_events;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.delivery_submitted_at IS NOT NULL OR NEW.review_by IS NOT NULL THEN
      RAISE EXCEPTION 'cannot prefill delivery clock';
    END IF;
  ELSIF OLD.state='ACTIVE' AND NEW.state='DELIVERED' THEN
    SELECT * INTO STRICT st FROM web3.chain_events WHERE id=NEW.last_event_id;
    SELECT * INTO STRICT ev FROM web3.chain_events
      WHERE chain_id=st.chain_id AND tx_hash=st.tx_hash AND block_hash=st.block_hash
        AND log_index=st.log_index-1 AND contract_address=st.contract_address
        AND escrow_id=st.escrow_id AND event_kind='EvidenceSubmitted';
    PERFORM web3.assert_final_event(ev.id);
    IF ev.payload->>'submittedAt' IS NULL OR ev.payload->>'reviewBy' IS NULL
      OR ev.payload->>'commitment' IS NULL
      OR ev.payload->>'commitment' !~ '^0x[0-9a-f]{64}$'
      OR ev.payload->>'commitment'='0x0000000000000000000000000000000000000000000000000000000000000000'
      OR NEW.delivery_submitted_at IS DISTINCT FROM to_timestamp((ev.payload->>'submittedAt')::bigint)
      OR NEW.review_by IS DISTINCT FROM to_timestamp((ev.payload->>'reviewBy')::bigint) THEN
      RAISE EXCEPTION 'delivery clock differs from evidence event';
    END IF;
  ELSIF ROW(NEW.delivery_submitted_at,NEW.review_by,NEW.review_period_seconds)
    IS DISTINCT FROM ROW(OLD.delivery_submitted_at,OLD.review_by,OLD.review_period_seconds) THEN
    RAISE EXCEPTION 'delivery clock immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER review_clock BEFORE INSERT OR UPDATE ON web3.escrows
  FOR EACH ROW EXECUTE FUNCTION web3.guard_review_clock();
COMMIT;
