// Shared PGlite fixture. All SQL values use parameters. No production HTTP/indexer.
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {deriveEscrowId,deriveTermsHash} from '../tools/escrow-identity.mjs';
export const h=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
export const a=n=>'0x'+BigInt(n).toString(16).padStart(40,'0');
export const u=n=>`00000000-0000-4000-8000-${n.toString().padStart(12,'0')}`;
export async function createFixture(overrides={}){
  const db=new PGlite();
  try {
    await db.exec(readFileSync('db/001_web3.sql','utf8'));
    await db.exec(`CREATE TABLE public.companies(id uuid PRIMARY KEY);
      CREATE TABLE public.users(id uuid PRIMARY KEY);`);
    await db.exec(readFileSync('db/002_ta_foreign_keys.sql','utf8'));
    await db.exec(readFileSync('db/003_p1_integrity.sql','utf8'));
    const now=Math.floor(Date.now()/1000);
    const t={chainId:31337,contract:a(2),token:a(1),payer:a(3),carrier:a(4),
      arbiter:a(5),backup:a(6),challenge:86400,arbitration:604800,
      nonce:h(77),agreement:h(88),amount:'100000000',acceptBy:now+86400,
      deliveryBy:now+864000,...overrides};
    for(const field of ['contract','token','payer','carrier','arbiter','backup']) t[field]=t[field].toLowerCase();
    t.id=deriveEscrowId(t.chainId,t.contract,t.payer,t.nonce);
    t.termsHash=deriveTermsHash(t);
    await db.query('INSERT INTO public.companies VALUES($1),($2),($3)',[u(1),u(2),u(3)]);
    await db.query('INSERT INTO public.users VALUES($1)',[u(4)]);
    await db.query('INSERT INTO web3.networks VALUES($1,$2,6,$3,0,$4)',
      [t.chainId,t.token,t.contract,h(1)]);
    await db.query(`INSERT INTO web3.deals VALUES($1,$2,$3,100,'EUR','EUR',1.1,'FIXTURE',
      now(),now()+interval '1 hour',$4,now())`,[u(10),u(1),u(2),t.agreement]);
    await db.query(`INSERT INTO web3.wallet_bindings VALUES
      ($1,$2,$3,$4,$5,$6,now(),NULL),($7,$8,$3,$4,$9,$10,now(),NULL)`,
      [u(60),u(1),u(4),t.chainId,t.payer,h(60),u(61),u(2),t.carrier,h(61)]);
    await freeze(db,t);
    return {db,t};
  } catch(error){await db.close();throw error}
}
export async function freeze(db,t,deal=u(10),payerBinding=u(60),carrierBinding=u(61)){
  await db.query(`INSERT INTO web3.deal_terms
    (deal_id,chain_id,escrow_id,payer_binding_id,carrier_binding_id,amount_atomic,
     accept_by,delivery_by,frozen_at,escrow_nonce,terms_hash)
    VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7),to_timestamp($8),now(),$9,$10)`,
    [deal,t.chainId,t.id,payerBinding,carrierBinding,t.amount,t.acceptBy,t.deliveryBy,t.nonce,t.termsHash]);
}
export async function recordFunding(db,t,{tx=h(3),block=h(4),height=10,
  fundingLog=0,stateLog=1,finalized=true,payload,
  fundingId=u(20),stateId=u(21),fundingKind='Funded'}={}){
  await db.query(`INSERT INTO web3.chain_transactions VALUES($1,$2,$3,$4,$5,true,now())`,
    [t.chainId,tx,finalized?'finalized':'included',block,height]);
  await db.query(`INSERT INTO web3.chain_events VALUES
    ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10),
    ($11,$2,$3,$4,$12,$6,$7,'StateChanged','{"state":"FUNDED"}',$10)`,
    [fundingId,t.chainId,tx,block,fundingLog,t.contract,t.id,fundingKind,
      JSON.stringify(payload??{payer:t.payer,carrier:t.carrier,amount:String(t.amount),termsHash:t.termsHash}),
      finalized,stateId,stateLog]);
}
export async function project(db,t,{fundingId=u(20),stateId=u(21),deal=u(10)}={}){
  return db.query(`INSERT INTO web3.escrows
    (deal_id,chain_id,escrow_id,payer_address,carrier_address,amount_atomic,terms_hash,
     accept_by,delivery_by,release_at,state,last_event_id,funding_event_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,to_timestamp($8),to_timestamp($9),NULL,'FUNDED',$10,$11)
    ON CONFLICT(deal_id) DO NOTHING RETURNING deal_id`,
    [deal,t.chainId,t.id,t.payer,t.carrier,t.amount,t.termsHash,t.acceptBy,t.deliveryBy,stateId,fundingId]);
}
