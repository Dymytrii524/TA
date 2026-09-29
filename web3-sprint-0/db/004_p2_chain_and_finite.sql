-- Apply after 003. Validate existing rows atomically; never repair frozen history.
-- Stop and obtain a reviewed remediation plan if any constraint validation fails.
BEGIN;
LOCK TABLE web3.intents, web3.intent_transactions, web3.deals, web3.deal_terms
  IN ACCESS EXCLUSIVE MODE;

-- Keep the existing transaction FK and one-transaction/one-intent uniqueness.
-- NO ACTION also protects parent-chain changes; no cascading chain rewrites.
ALTER TABLE web3.intents
  ADD CONSTRAINT intents_id_chain_unique UNIQUE(id,chain_id);
ALTER TABLE web3.intent_transactions
  ADD CONSTRAINT intent_transactions_same_chain
  FOREIGN KEY(intent_id,chain_id) REFERENCES web3.intents(id,chain_id)
  ON UPDATE NO ACTION ON DELETE NO ACTION;

-- PostgreSQL numeric NaN/Infinity can satisfy positive checks. No typmod,
-- conversion or rounding is introduced; existing price precision rules remain.
ALTER TABLE web3.deals
  ADD CONSTRAINT deal_price_finite CHECK
    (price_amount NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
  ADD CONSTRAINT deal_fx_finite CHECK
    (fx_rate NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric));

-- Validate immutable history too, even if the mutable deal was since corrected.
-- The existing BEFORE INSERT freeze trigger copies actual deal values; this
-- constraint checks that generated snapshot and does not trust caller JSON.
ALTER TABLE web3.deal_terms
  ADD CONSTRAINT snapshot_price_finite CHECK
    (commercial_snapshot->>'price_amount' IS NOT NULL AND
     (commercial_snapshot->>'price_amount')::numeric
       NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
  ADD CONSTRAINT snapshot_fx_finite CHECK
    (commercial_snapshot->>'fx_rate' IS NOT NULL AND
     (commercial_snapshot->>'fx_rate')::numeric
       NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric));
COMMIT;
