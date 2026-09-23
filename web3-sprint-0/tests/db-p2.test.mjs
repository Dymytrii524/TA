import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFixture,freeze,a,h,u} from './p1-fixture.mjs';
import {deriveEscrowId,deriveTermsHash} from '../tools/escrow-identity.mjs';

const migration=readFileSync('db/004_p2_chain_and_finite.sql','utf8');
let checks=0;
const pass=label=>{checks++;console.log(`PASS ${label}`)};
const rejects=(fn,code,constraint)=>assert.rejects(fn,e=>
  e.code===code && (!constraint || e.constraint===constraint));
const amoy=db=>db.query(`INSERT INTO web3.networks VALUES
  (80002,'0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582',6,$1,0,$2)`,[a(9),h(9)]);
// Non-create intent isolates FK integrity from the P1 prepared-create guard.
const intent=(db,id=u(40),chain=31337)=>db.query(`INSERT INTO web3.intents VALUES
  ($1,$2,$3,$4,'accept','1234567890abcdef',$5,'submitted',now(),now()+interval '5 minutes')`,
  [id,u(10),u(4),chain,h(40)]);
const tx=(db,chain,hash)=>db.query(`INSERT INTO web3.chain_transactions
  VALUES($1,$2,'submitted',NULL,NULL,NULL,now())`,[chain,hash]);
const link=(db,id,chain,hash)=>db.query('INSERT INTO web3.intent_transactions VALUES($1,$2,$3)',
  [id,chain,hash]);
const cloneDeal=(db,price,fx)=>db.query(`INSERT INTO web3.deals SELECT
  $1,payer_company_id,carrier_company_id,$2::numeric,price_currency,contract_currency,
  $3::numeric,fx_source,fx_fixed_at,fx_expires_at,agreement_commitment,created_at
  FROM web3.deals WHERE id=$4`,[u(11),price,fx,u(10)]);
const nextTerms=t=>{
  const next={...t,nonce:h(81)};
  next.id=deriveEscrowId(next.chainId,next.contract,next.payer,next.nonce);
  next.termsHash=deriveTermsHash(next);
  return next;
};

const {db,t}=await createFixture();
async function scenario(label,fn){
  await db.exec('BEGIN');
  try{await fn();pass(label)}finally{await db.exec('ROLLBACK')}
}
try{
  pass('001/002/003/004 install on an empty schema');
  for(const [origin,other] of [[31337,80002],[80002,31337]]){
    await scenario(`F04 rejects cross-chain INSERT ${origin}->${other}`,async()=>{
      await amoy(db);await intent(db,u(40),origin);await tx(db,other,h(33));
      await rejects(()=>link(db,u(40),other,h(33)),'23503','intent_transactions_same_chain');
    });
    await scenario(`F04 rejects association chain UPDATE ${origin}->${other}`,async()=>{
      await amoy(db);await intent(db,u(40),origin);
      await tx(db,origin,h(33));await tx(db,other,h(33));await link(db,u(40),origin,h(33));
      await rejects(()=>db.query('UPDATE web3.intent_transactions SET chain_id=$1',[other]),
        '23503','intent_transactions_same_chain');
    });
    await scenario(`F04 rejects parent intent chain UPDATE ${origin}->${other}`,async()=>{
      await amoy(db);await intent(db,u(40),origin);
      await tx(db,origin,h(33));await link(db,u(40),origin,h(33));
      await rejects(()=>db.query('UPDATE web3.intents SET chain_id=$1',[other]),
        '23503','intent_transactions_same_chain');
    });
    await scenario(`F04 same-chain replacement and replay work on ${origin}`,async()=>{
      await amoy(db);await intent(db,u(40),origin);
      for(const hash of [h(33),h(34)]){
        await tx(db,origin,hash);await link(db,u(40),origin,hash);
      }
      await db.query(`INSERT INTO web3.intent_transactions VALUES($1,$2,$3)
        ON CONFLICT(intent_id,chain_id,tx_hash) DO NOTHING`,[u(40),origin,h(34)]);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM web3.intent_transactions')).rows[0].n,2);
    });
  }
  await scenario('F04 rejects reassignment to an intent on another chain',async()=>{
    await amoy(db);await intent(db);
    await db.query(`INSERT INTO web3.intents SELECT $1,deal_id,actor_user_id,80002,action,
      'different-key-1234',request_hash,status,created_at,expires_at FROM web3.intents`,[u(41)]);
    await tx(db,31337,h(33));await link(db,u(40),31337,h(33));
    await rejects(()=>db.query('UPDATE web3.intent_transactions SET intent_id=$1',[u(41)]),
      '23503','intent_transactions_same_chain');
  });
  await scenario('F04 existing transaction FK still rejects missing transactions',async()=>{
    await intent(db);
    await rejects(()=>link(db,u(40),31337,h(33)),'23503');
  });
  await scenario('F04 one transaction cannot be assigned to two intents',async()=>{
    await intent(db);
    await db.query(`INSERT INTO web3.intents SELECT $1,deal_id,actor_user_id,chain_id,action,
      'different-key-1234',request_hash,status,created_at,expires_at FROM web3.intents`,[u(41)]);
    await tx(db,31337,h(33));await link(db,u(40),31337,h(33));
    await rejects(()=>link(db,u(41),31337,h(33)),'23505');
  });
  await scenario('F04 parent transaction chain cannot orphan an association',async()=>{
    await amoy(db);await intent(db);await tx(db,31337,h(33));await link(db,u(40),31337,h(33));
    await rejects(()=>db.exec('UPDATE web3.chain_transactions SET chain_id=80002'),'23503');
  });
  for(const field of ['price_amount','fx_rate']){
    for(const value of ['NaN','Infinity','-Infinity']){
      await scenario(`F06 rejects ${field} INSERT ${value}`,()=>
        rejects(()=>cloneDeal(db,field==='price_amount'?value:'123.45',field==='fx_rate'?value:'1.1'),
          '23514'));
      await scenario(`F06 rejects ${field} UPDATE ${value}`,()=>
        rejects(()=>db.query(`UPDATE web3.deals SET ${field}=$1`,[value]),'23514'));
    }
    for(const value of ['0','-1']){
      await scenario(`F06 preserves ${field} positive-only rule for ${value}`,()=>
        rejects(()=>db.query(`UPDATE web3.deals SET ${field}=$1`,[value]),'23514'));
    }
  }
  await scenario('F06 preserves two-decimal price validation without rounding',()=>
    rejects(()=>cloneDeal(db,'123.456','1.1'),'23514'));
  await scenario('F06 finite values freeze exactly and caller JSON cannot replace them',async()=>{
    await cloneDeal(db,'123.45','1.1234567890123456789');
    const next=nextTerms(t);
    await db.query(`INSERT INTO web3.deal_terms
      (deal_id,chain_id,escrow_id,payer_binding_id,carrier_binding_id,amount_atomic,
       accept_by,delivery_by,frozen_at,escrow_nonce,terms_hash,commercial_snapshot)
      VALUES($1,31337,$2,$3,$4,$5,to_timestamp($6),to_timestamp($7),now(),$8,$9,
        '{"price_amount":"NaN","fx_rate":"Infinity"}')`,
      [u(11),next.id,u(60),u(61),next.amount,next.acceptBy,next.deliveryBy,next.nonce,next.termsHash]);
    const row=(await db.query(`SELECT commercial_snapshot->>'price_amount' AS price,
      commercial_snapshot->>'fx_rate' AS fx FROM web3.deal_terms WHERE deal_id=$1`,[u(11)])).rows[0];
    assert.equal(row.price,'123.45');assert.equal(row.fx,'1.1234567890123456789');
  });
  await scenario('F06 finite mutable update still leaves historical snapshot unchanged',async()=>{
    const before=(await db.query('SELECT commercial_snapshot FROM web3.deal_terms')).rows[0];
    await db.exec('UPDATE web3.deals SET price_amount=999.99,fx_rate=1.23456789');
    assert.deepEqual((await db.query('SELECT commercial_snapshot FROM web3.deal_terms')).rows[0],before);
  });
}finally{await db.close()}

// Build real pre-004 data without disabling triggers or modifying prior migrations.
async function historical(label,setup,expectedConstraint){
  const {db,t}=await createFixture({}, {applyP2:false});
  try{
    await setup(db,t);
    const before=(await db.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM web3.deals d) AS deals,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY deal_id) FROM web3.deal_terms t) AS terms,
      (SELECT jsonb_agg(to_jsonb(x) ORDER BY intent_id,chain_id,tx_hash)
        FROM web3.intent_transactions x) AS links`)).rows[0];
    if(expectedConstraint){
      await rejects(()=>db.exec(migration),expectedConstraint==='intent_transactions_same_chain'?'23503':'23514',
        expectedConstraint);
      await db.exec('ROLLBACK');
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM pg_constraint
        WHERE connamespace='web3'::regnamespace AND conname IN
        ('intents_id_chain_unique','intent_transactions_same_chain','deal_price_finite',
         'deal_fx_finite','snapshot_price_finite','snapshot_fx_finite')`)).rows[0].n,0);
    }else{
      await db.exec(migration);
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM pg_constraint
        WHERE connamespace='web3'::regnamespace AND convalidated AND conname IN
        ('intents_id_chain_unique','intent_transactions_same_chain','deal_price_finite',
         'deal_fx_finite','snapshot_price_finite','snapshot_fx_finite')`)).rows[0].n,6);
    }
    const after=(await db.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM web3.deals d) AS deals,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY deal_id) FROM web3.deal_terms t) AS terms,
      (SELECT jsonb_agg(to_jsonb(x) ORDER BY intent_id,chain_id,tx_hash)
        FROM web3.intent_transactions x) AS links`)).rows[0];
    assert.deepEqual(after,before);pass(label);
  }finally{await db.close()}
}
await historical('004 accepts valid populated history without rewriting it',async db=>{
  await intent(db);await tx(db,31337,h(33));await link(db,u(40),31337,h(33));
});
await historical('004 rejects historical cross-chain link and rolls back all DDL',async db=>{
  await amoy(db);await intent(db);await tx(db,80002,h(33));await link(db,u(40),80002,h(33));
},'intent_transactions_same_chain');
for(const field of ['price_amount','fx_rate']){
  for(const value of ['NaN','Infinity']){
    await historical(`004 refuses historical ${field}=${value}, preserving data`,db=>
      db.query(`UPDATE web3.deals SET ${field}=$1`,[value]),
      field==='price_amount'?'deal_price_finite':'deal_fx_finite');
    await historical(`004 refuses frozen ${field}=${value} even after mutable repair`,async(db,t)=>{
      await cloneDeal(db,field==='price_amount'?value:'123.45',field==='fx_rate'?value:'1.1');
      await freeze(db,nextTerms(t),u(11));
      await db.query(`UPDATE web3.deals SET ${field}=1 WHERE id=$1`,[u(11)]);
    },field==='price_amount'?'snapshot_price_finite':'snapshot_fx_finite');
  }
}
console.log(`P2 DB regression checks: ${checks} passed; PGlite, not multi-session PostgreSQL concurrency.`);
