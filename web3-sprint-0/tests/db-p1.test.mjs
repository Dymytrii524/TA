import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFixture,freeze,recordFunding,project,a,h,u} from './p1-fixture.mjs';
const {db,t}=await createFixture();
let checks=0;
const pass=label=>{checks++;console.log(`PASS ${label}`)};
async function scenario(label,fn){
  await db.exec('BEGIN');
  try {await fn();pass(label)} finally {await db.exec('ROLLBACK')}
}
const reject=async(fn,pattern)=>assert.rejects(fn,pattern);
const insertIntent=()=>db.query(`INSERT INTO web3.intents VALUES
  ($1,$2,$3,31337,'create','1234567890abcdef',$4,'prepared',now(),now()+interval '5 minutes')`,
  [u(40),u(10),u(4),h(40)]);
try {
  pass('001 + 002 + 003 migrate on empty schema');
  const original=(await db.query('SELECT * FROM web3.deal_terms')).rows[0];
  for(const [field,value] of [['wallet_address',a(99)],['company_id',u(3)],
    ['chain_id',80002],['verified_by_user_id',u(4)],['challenge_hash',h(99)]]){
    // verified_by unchanged would be a no-op; use another non-existent UUID to test guard, not FK.
    const next=field==='verified_by_user_id'?u(99):value;
    await scenario(`F02 binding ${field} immutable`,()=>reject(
      ()=>db.query(`UPDATE web3.wallet_bindings SET ${field}=$1 WHERE id=$2`,[next,u(61)]),
      /binding identity is immutable/));
  }
  await scenario('F02 binding history cannot be deleted',()=>reject(
    ()=>db.query('DELETE FROM web3.wallet_bindings WHERE id=$1',[u(61)]),/binding history/));
  await scenario('F02 mutable commercial values cannot alter frozen snapshot',async()=>{
    await db.query(`UPDATE web3.deals SET agreement_commitment=$1,fx_rate=2,
      price_amount=250,payer_company_id=$2,carrier_company_id=$3 WHERE id=$4`,
      [h(99),u(3),u(1),u(10)]);
    assert.deepEqual((await db.query('SELECT * FROM web3.deal_terms')).rows[0],original);
  });
  await scenario('F02 frozen row cannot be rewritten',()=>reject(
    ()=>db.exec(`UPDATE web3.deal_terms SET commercial_snapshot='{}'`),/append-only/));
  await scenario('F02 valid create intent still accepted',insertIntent);
  await scenario('F02 revocation preserves snapshot and blocks new create intents',async()=>{
    await db.query('UPDATE web3.wallet_bindings SET revoked_at=now() WHERE id=$1',[u(61)]);
    assert.deepEqual((await db.query('SELECT * FROM web3.deal_terms')).rows[0],original);
    await reject(insertIntent,/active frozen bindings/);
  });
  await scenario('F02 revocation cannot be undone',async()=>{
    await db.query('UPDATE web3.wallet_bindings SET revoked_at=now() WHERE id=$1',[u(61)]);
    await reject(()=>db.query('UPDATE web3.wallet_bindings SET revoked_at=NULL WHERE id=$1',[u(61)]),
      /binding identity/);
  });
  for(const kind of ['company','revoked','chain']){
    await scenario(`F02 new freeze rejects ${kind} binding`,async()=>{
      await db.query(`INSERT INTO web3.deals SELECT $1,payer_company_id,carrier_company_id,
        price_amount,price_currency,contract_currency,fx_rate,fx_source,fx_fixed_at,fx_expires_at,
        agreement_commitment,created_at FROM web3.deals WHERE id=$2`,[u(11),u(10)]);
      if(kind==='company') await db.query('UPDATE web3.deals SET carrier_company_id=$1 WHERE id=$2',[u(3),u(11)]);
      if(kind==='revoked') await db.query('UPDATE web3.wallet_bindings SET revoked_at=now() WHERE id=$1',[u(61)]);
      if(kind==='chain') await db.query(`INSERT INTO web3.networks VALUES
        (80002,'0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582',6,$1,0,$2)`,[a(9),h(9)]);
      await reject(()=>freeze(db,{...t,chainId:kind==='chain'?80002:31337},u(11)),
        /invalid active party bindings/);
    });
  }
  await scenario('F03 valid funded event pair projects atomically',async()=>{
    await recordFunding(db,t);await project(db,t);
    assert.equal((await db.query('SELECT amount_atomic::text FROM web3.escrows')).rows[0].amount_atomic,t.amount);
  });
  for(const [field,value] of [['amount','999999999'],['payer',a(99)],['carrier',a(99)],
    ['termsHash',h(99)],['id',h(99)],['acceptBy',t.acceptBy+1],['deliveryBy',t.deliveryBy+1]]){
    await scenario(`F03 projection rejects wrong ${field}`,async()=>{
      await recordFunding(db,t);
      await reject(()=>project(db,{...t,[field]:value}),/projection differs from frozen terms/);
    });
  }
  for(const field of ['payer','carrier','amount','termsHash']){
    await scenario(`F03 funding payload rejects wrong ${field}`,async()=>{
      const payload={payer:t.payer,carrier:t.carrier,amount:t.amount,termsHash:t.termsHash};
      payload[field]=field==='amount'?'999':field==='termsHash'?h(99):a(99);
      await recordFunding(db,t,{payload});
      await reject(()=>project(db,t),/funding event differs/);
    });
    await scenario(`F03 funding payload requires ${field}`,async()=>{
      const payload={payer:t.payer,carrier:t.carrier,amount:t.amount,termsHash:t.termsHash};
      delete payload[field];await recordFunding(db,t,{payload});
      await reject(()=>project(db,t),/funding event differs/);
    });
  }
  for(const [label,options,pattern] of [
    ['unfinalized',{finalized:false},/unverified chain event/],
    ['non-adjacent logs',{stateLog:2},/funding event differs/],
    ['wrong event kind',{fundingKind:'Settled'},/funding event differs/]
  ]) await scenario(`F03 rejects ${label}`,async()=>{
    await recordFunding(db,t,options);await reject(()=>project(db,t),pattern);
  });
  await scenario('F03 rejects cross-transaction event pair',async()=>{
    await recordFunding(db,t);
    await recordFunding(db,t,{tx:h(33),fundingId:u(30),stateId:u(31)});
    await reject(()=>project(db,t,{stateId:u(31)}),/funding event differs/);
  });
  await scenario('F03 validated replay is idempotent without another escrow',async()=>{
    await recordFunding(db,t);await project(db,t);
    assert.equal((await project(db,t)).rows.length,0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM web3.escrows')).rows[0].n,1);
  });
  await scenario('F03 projection delete/reinsert blocked',async()=>{
    await recordFunding(db,t);await project(db,t);
    await reject(()=>db.exec('DELETE FROM web3.escrows'),/cannot be deleted/);
  });
  await scenario('F03 projection TRUNCATE blocked',()=>reject(
    ()=>db.exec('TRUNCATE web3.escrows'),/append-only/));
  await scenario('F02 terms TRUNCATE blocked',()=>reject(
    ()=>db.exec('TRUNCATE web3.deal_terms'),/append-only/));
  await scenario('F03 funding reference immutable',async()=>{
    await recordFunding(db,t);await project(db,t);
    await reject(()=>db.query('UPDATE web3.escrows SET funding_event_id=$1',[u(21)]),
      /funding evidence is immutable/);
  });
  await scenario('F03 valid later state transition keeps funding evidence',async()=>{
    await recordFunding(db,t);await project(db,t);
    await db.query(`INSERT INTO web3.chain_events SELECT $1,chain_id,tx_hash,block_hash,2,
      contract_address,escrow_id,'StateChanged','{"state":"ACTIVE"}',true
      FROM web3.chain_events WHERE id=$2`,[u(22),u(20)]);
    await db.query(`UPDATE web3.escrows SET state='ACTIVE',last_event_id=$1`,[u(22)]);
    assert.equal((await db.query('SELECT funding_event_id FROM web3.escrows')).rows[0].funding_event_id,u(20));
  });
  // An already-populated installation must fail before any DDL/backfill.
  await reject(()=>db.exec(readFileSync('db/003_p1_integrity.sql','utf8')),
    /reviewed historical backfill required/);
  await db.exec('ROLLBACK');pass('P1 migration refuses existing frozen history');
  console.log(`P1 DB regression checks: ${checks} passed; PGlite, not a production PostgreSQL deployment.`);
} finally {await db.close()}
