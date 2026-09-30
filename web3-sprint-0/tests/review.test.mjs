import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFixture,recordFunding,project,h,u,a} from './p1-fixture.mjs';
import {reviewClock,reviewAction} from '../runtime/review.mjs';
let checks=0;
const d={state:3,payer:a(3),deliveryBy:1000n,deliverySubmittedAt:1000n,reviewBy:173800n,evidence:h(20)};
assert.equal(reviewClock(d).review_period_seconds,172800);checks++;
for(const t of [173799n,173800n]){
  assert.ok(reviewAction({deal:d,id:h(1),actor:a(3),action:'approveDelivery',evidence:h(20),now:t}));checks++;
  assert.throws(()=>reviewAction({deal:d,id:h(1),actor:a(8),action:'escalateOverdue',now:t}));checks++;
}
assert.throws(()=>reviewAction({deal:d,id:h(1),actor:a(3),action:'approveDelivery',evidence:h(20),now:173801n}));checks++;
assert.ok(reviewAction({deal:d,id:h(1),actor:a(8),action:'escalateOverdue',now:173801n}));checks++;
for(const override of [{actor:a(8)},{evidence:h(21)},{deal:{...d,state:5}}]){
  assert.throws(()=>reviewAction({deal:d,id:h(1),actor:a(3),action:'approveDelivery',evidence:h(20),now:1001n,...override}));checks++;
}
assert.throws(()=>reviewClock({...d,reviewBy:173801n}));checks++;
const {db,t}=await createFixture();
try{
  assert.equal((await db.query('SELECT terms_version,review_period_seconds FROM web3.deal_terms')).rows[0].terms_version,2);checks++;
  await assert.rejects(()=>db.query("UPDATE web3.deal_terms SET review_period_seconds=86400"));checks++;
  await recordFunding(db,t);await project(db,t);
  const event=async(id,kind,payload,index)=>db.query(`INSERT INTO web3.chain_events
    (id,chain_id,tx_hash,block_hash,log_index,contract_address,escrow_id,event_kind,payload,finalized)
    VALUES($1,31337,$2,$3,$4,$5,$6,$7,$8::jsonb,true)`,
    [u(id),h(3),h(4),index,t.contract,t.id,kind,JSON.stringify(payload)]);
  await event(100,'StateChanged',{state:'ACTIVE'},2);
  await db.query("UPDATE web3.escrows SET state='ACTIVE',last_event_id=$1",[u(100)]);
  const submitted=t.deliveryBy,review=submitted+172800;
  await event(101,'EvidenceSubmitted',{commitment:h(20),submittedAt:String(submitted),reviewBy:String(review)},3);
  await event(102,'StateChanged',{state:'DELIVERED'},4);
  for(const [s,r] of [[submitted,review+1],[submitted-1,review],[submitted,null]]){
    await assert.rejects(()=>db.query(`UPDATE web3.escrows SET state='DELIVERED',last_event_id=$1,
      delivery_submitted_at=to_timestamp($2),review_by=to_timestamp($3)`,[u(102),s,r]));checks++;
  }
  await db.query(`UPDATE web3.escrows SET state='DELIVERED',last_event_id=$1,
    delivery_submitted_at=to_timestamp($2),review_by=to_timestamp($3)`,[u(102),submitted,review]);checks++;
  await event(103,'StateChanged',{state:'DISPUTED'},5);
  await assert.rejects(()=>db.query(`UPDATE web3.escrows SET state='DISPUTED',last_event_id=$1,
    delivery_submitted_at=delivery_submitted_at+interval '1 second',review_by=review_by+interval '1 second'`,[u(103)]));checks++;
  await db.query("UPDATE web3.escrows SET state='DISPUTED',last_event_id=$1",[u(103)]);checks++;
  console.log(`F07 API/SQL regression checks: ${checks} passed`);
}finally{await db.close()}
const old=await createFixture({}, {applyReview:false});
try{
  await assert.rejects(()=>old.db.exec(readFileSync('db/006_review_window.sql','utf8')),/reviewed version migration/);
  await old.db.exec('ROLLBACK');
  assert.equal((await old.db.query(`SELECT count(*) n FROM information_schema.columns
    WHERE table_schema='web3' AND table_name='deal_terms' AND column_name='terms_version'`)).rows[0].n,0);
  console.log('PASS F07 historical freeze rejects migration atomically');
}finally{await old.db.close()}
