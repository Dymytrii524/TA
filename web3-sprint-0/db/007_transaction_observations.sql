-- R21-01: preserve pre-finality observations before verified promotion.
BEGIN;
CREATE TABLE web3.transaction_observations (
  id uuid PRIMARY KEY,
  chain_id bigint NOT NULL,
  tx_hash web3.hash NOT NULL,
  previous jsonb NOT NULL,
  verified jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(chain_id,tx_hash) REFERENCES web3.chain_transactions
);
CREATE TRIGGER observation_immutable BEFORE UPDATE OR DELETE ON web3.transaction_observations
  FOR EACH ROW EXECUTE FUNCTION web3.no_mutation();
CREATE TRIGGER observation_no_truncate BEFORE TRUNCATE ON web3.transaction_observations
  FOR EACH STATEMENT EXECUTE FUNCTION web3.no_mutation();
REVOKE ALL ON web3.transaction_observations FROM PUBLIC;
COMMIT;
