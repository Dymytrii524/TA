-- R21-04: server-observed, pre-funding evidence. Never infer causality from clocks.
BEGIN;
CREATE TABLE web3.mapping_preflight (
  deal_id uuid PRIMARY KEY REFERENCES web3.deal_terms(deal_id),
  chain_id bigint NOT NULL REFERENCES web3.networks,
  contract_address web3.address NOT NULL,
  escrow_id web3.hash NOT NULL,
  terms_hash web3.hash NOT NULL,
  block_number bigint NOT NULL CHECK(block_number>=0),
  block_hash web3.hash NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(chain_id,contract_address,escrow_id)
);
CREATE FUNCTION web3.guard_mapping_preflight() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT FROM web3.deal_terms t WHERE t.deal_id=NEW.deal_id
    AND t.chain_id=NEW.chain_id AND t.escrow_address=NEW.contract_address
    AND t.escrow_id=NEW.escrow_id AND t.terms_hash=NEW.terms_hash)
  THEN RAISE EXCEPTION 'preflight scope mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mapping_preflight_scope BEFORE INSERT ON web3.mapping_preflight
  FOR EACH ROW EXECUTE FUNCTION web3.guard_mapping_preflight();
CREATE TRIGGER mapping_preflight_immutable BEFORE UPDATE OR DELETE ON web3.mapping_preflight
  FOR EACH ROW EXECUTE FUNCTION web3.no_mutation();
CREATE TRIGGER mapping_preflight_no_truncate BEFORE TRUNCATE ON web3.mapping_preflight
  FOR EACH STATEMENT EXECUTE FUNCTION web3.no_mutation();
REVOKE ALL ON web3.mapping_preflight FROM PUBLIC;
COMMIT;
