-- Apply AFTER TA sprint-0-backend/001_init.sql and web3/001_web3.sql.
-- Tests use explicit minimal public parent fixtures, not a full TA/PostGIS deployment.
BEGIN;
ALTER TABLE web3.wallet_bindings ADD FOREIGN KEY(company_id) REFERENCES public.companies(id);
ALTER TABLE web3.wallet_bindings ADD FOREIGN KEY(verified_by_user_id) REFERENCES public.users(id);
ALTER TABLE web3.deals ADD FOREIGN KEY(payer_company_id) REFERENCES public.companies(id);
ALTER TABLE web3.deals ADD FOREIGN KEY(carrier_company_id) REFERENCES public.companies(id);
ALTER TABLE web3.intents ADD FOREIGN KEY(actor_user_id) REFERENCES public.users(id);
ALTER TABLE web3.evidence ADD FOREIGN KEY(uploaded_by_user_id) REFERENCES public.users(id);
COMMIT;
