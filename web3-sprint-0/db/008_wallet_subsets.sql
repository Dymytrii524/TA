-- R21-02/B: side-by-side V2. No rewriting/deletion of V1 snapshots.
BEGIN;
CREATE TABLE web3.wallet_snapshots_v2 (
  id uuid PRIMARY KEY,
  chain_id bigint NOT NULL REFERENCES web3.networks,
  contract_address web3.address NOT NULL,
  token_address web3.address NOT NULL,
  block_number bigint NOT NULL CHECK(block_number>=0),
  block_hash web3.hash NOT NULL,
  policy_version text NOT NULL CHECK(policy_version='F05-B/2'),
  projection_revision bigint NOT NULL CHECK(projection_revision>0),
  classification_hash web3.hash NOT NULL,
  subledger jsonb NOT NULL CHECK(jsonb_typeof(subledger)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(chain_id,contract_address,block_hash,policy_version,projection_revision),
  UNIQUE(id,chain_id,contract_address)
);
CREATE TABLE web3.wallet_active_snapshot (
  chain_id bigint NOT NULL,
  contract_address web3.address NOT NULL,
  snapshot_id uuid NOT NULL,
  PRIMARY KEY(chain_id,contract_address),
  FOREIGN KEY(snapshot_id,chain_id,contract_address)
    REFERENCES web3.wallet_snapshots_v2(id,chain_id,contract_address)
);
-- Trusted offline maintenance only; no HTTP endpoint. Two distinct approvers.
-- A hash is an audit reference, NOT a substitute for matching immutable terms.
CREATE TABLE web3.wallet_mapping_approvals (
  id uuid PRIMARY KEY,
  chain_id bigint NOT NULL,
  contract_address web3.address NOT NULL,
  escrow_id web3.hash NOT NULL,
  deal_id uuid NOT NULL REFERENCES web3.deal_terms(deal_id),
  evidence_hash web3.hash NOT NULL CHECK(evidence_hash<>'0x0000000000000000000000000000000000000000000000000000000000000000'),
  requested_by uuid NOT NULL REFERENCES public.users,
  approved_by uuid NOT NULL REFERENCES public.users,
  CHECK(requested_by<>approved_by),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(chain_id,contract_address,escrow_id)
);
CREATE FUNCTION web3.guard_mapping_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT FROM web3.deal_terms t WHERE t.deal_id=NEW.deal_id
      AND t.chain_id=NEW.chain_id AND t.escrow_address=NEW.contract_address
      AND t.escrow_id=NEW.escrow_id) THEN RAISE EXCEPTION 'mapping scope mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mapping_approval_scope BEFORE INSERT ON web3.wallet_mapping_approvals
  FOR EACH ROW EXECUTE FUNCTION web3.guard_mapping_approval();
CREATE TRIGGER mapping_approval_immutable BEFORE UPDATE OR DELETE ON web3.wallet_mapping_approvals
  FOR EACH ROW EXECUTE FUNCTION web3.no_mutation();
CREATE TRIGGER mapping_approval_no_truncate BEFORE TRUNCATE ON web3.wallet_mapping_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION web3.no_mutation();
CREATE TRIGGER snapshot_v2_immutable BEFORE UPDATE OR DELETE ON web3.wallet_snapshots_v2
  FOR EACH ROW EXECUTE FUNCTION web3.no_mutation();
CREATE TRIGGER snapshot_v2_no_truncate BEFORE TRUNCATE ON web3.wallet_snapshots_v2
  FOR EACH STATEMENT EXECUTE FUNCTION web3.no_mutation();
REVOKE ALL ON web3.wallet_snapshots_v2,web3.wallet_active_snapshot,web3.wallet_mapping_approvals FROM PUBLIC;
COMMIT;
