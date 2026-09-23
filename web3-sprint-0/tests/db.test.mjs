import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const db=new PGlite();
let checks=0;
const pass=(s)=>{checks++;console.log(`PASS ${s}`)};
async function rejects(sql,label){
  await assert.rejects(()=>db.exec(sql)); pass(label);
}
const h=n=>'0x'+n.toString(16).padStart(64,'0');
const a=n=>'0x'+n.toString(16).padStart(40,'0');
const u=n=>`00000000-0000-4000-8000-${n.toString().padStart(12,'0')}`;
try{
  console.log((await db.query('select version()')).rows[0]);
  await db.exec(readFileSync('db/001_web3.sql','utf8')); pass('migration');
  await db.exec(`CREATE TABLE public.companies(id uuid PRIMARY KEY); CREATE TABLE public.users(id uuid PRIMARY KEY);
    INSERT INTO companies VALUES('${u(1)}'),('${u(2)}'); INSERT INTO users VALUES('${u(3)}');`);
  await db.exec(readFileSync('db/002_ta_foreign_keys.sql','utf8')); pass('TA foreign keys against explicit parent fixtures');
  await db.exec(`INSERT INTO web3.networks VALUES(31337,'${a(1)}',6,'${a(2)}',0,'${h(1)}')`);
  await rejects(`INSERT INTO web3.networks VALUES(137,'${a(1)}',6,'${a(2)}',0,'${h(1)}')`,'mainnet denied');
  await rejects(`INSERT INTO web3.networks VALUES(80002,'${a(1)}',6,'${a(2)}',0,'${h(1)}')`,'wrong Amoy token denied');
  await rejects(`SELECT '0.1'::web3.uint256`,'fractional atomic amount rejected');
  await rejects(`SELECT '-1'::web3.uint256`,'negative atomic amount rejected');
  await rejects(`SELECT '${'9'.repeat(78)}'::web3.uint256`,'uint256 overflow rejected');
  await db.exec(`INSERT INTO web3.deals VALUES('${u(10)}','${u(1)}','${u(2)}',2400,'EUR','EUR',1.1,'TEST_FIXTURE',
    now(),now()+interval '1 hour','${h(2)}',now())`);
  await rejects(`INSERT INTO web3.deals SELECT '${u(11)}','${u(1)}','${u(1)}',2400,'EUR','EUR',1.1,'TEST',
    now(),now()+interval '1 hour','${h(2)}',now()`,'same company rejected');
  await rejects(`INSERT INTO web3.deals SELECT '${u(11)}','${u(99)}','${u(2)}',2400,'EUR','EUR',1.1,'TEST',
    now(),now()+interval '1 hour','${h(2)}',now()`,'unknown company FK rejected');
  await db.exec(`INSERT INTO web3.chain_transactions VALUES(31337,'${h(3)}','submitted',NULL,NULL,NULL,now())`);
  await rejects(`UPDATE web3.chain_transactions SET state='finalized' WHERE tx_hash='${h(3)}'`,'receipt required');
  await db.exec(`INSERT INTO web3.chain_events VALUES('${u(20)}',31337,'${h(3)}','${h(4)}',0,'${a(2)}','${h(5)}','StateChanged','{"state":"FUNDED"}',false)`);
  const escrow=`INSERT INTO web3.escrows VALUES('${u(10)}',31337,'${h(5)}','${a(3)}','${a(4)}',2640000000,'${h(6)}',
    now()+interval '1 day',now()+interval '10 days',NULL,'FUNDED','${u(20)}')`;
  await rejects(escrow,'unfinalized event rejected');
  await db.exec(`UPDATE web3.chain_transactions SET state='finalized',block_hash='${h(4)}',block_number=10,receipt_success=true;
    UPDATE web3.chain_events SET finalized=true;`);
  await db.exec(escrow); pass('finalized funding projects');
  await rejects(`UPDATE web3.chain_transactions SET state='orphaned'`,'finality breach halts');
  await rejects(`DELETE FROM web3.chain_events WHERE id='${u(20)}'`,'finalized event immutable');
  await rejects(`UPDATE web3.escrows SET amount_atomic=1`,'immutable amount rejected');
  await db.exec(`INSERT INTO web3.chain_events VALUES('${u(21)}',31337,'${h(3)}','${h(4)}',1,'${a(2)}','${h(5)}','StateChanged','{"state":"ACCEPTED"}',true)`);
  await rejects(`UPDATE web3.escrows SET state='ACCEPTED',release_at=now(),last_event_id='${u(21)}'`,'illegal state jump rejected');
  await rejects(`INSERT INTO web3.chain_events SELECT '${u(22)}',chain_id,tx_hash,block_hash,log_index,contract_address,escrow_id,event_kind,payload,finalized FROM web3.chain_events WHERE id='${u(20)}'`,'duplicate chain log rejected');
  await rejects(`INSERT INTO web3.ledger_entries VALUES('${u(30)}',1,'${u(20)}','asset',100,now())`,'unbalanced ledger rejected');
  await db.exec(`BEGIN;
    INSERT INTO web3.ledger_entries VALUES('${u(31)}',1,'${u(20)}','asset',100,now()),('${u(31)}',2,'${u(20)}','liability',-100,now());
    COMMIT;`); pass('balanced ledger committed');
  await rejects(`UPDATE web3.ledger_entries SET amount_atomic=200`,'journal immutable');
  await rejects(`DELETE FROM web3.ledger_entries`,'journal undeletable');
  await db.exec(`INSERT INTO web3.intents VALUES('${u(40)}','${u(10)}','${u(3)}',31337,'create','1234567890abcdef','${h(7)}','prepared',now(),now()+interval '5 minutes')`);
  await rejects(`INSERT INTO web3.intents SELECT '${u(41)}',deal_id,actor_user_id,chain_id,action,idempotency_key,request_hash,status,created_at,expires_at FROM web3.intents`,'idempotency uniqueness');
  await db.exec(`INSERT INTO web3.wallet_bindings VALUES
    ('${u(60)}','${u(1)}','${u(3)}',31337,'${a(3)}','${h(60)}',now(),NULL),
    ('${u(61)}','${u(2)}','${u(3)}',31337,'${a(4)}','${h(61)}',now(),NULL);
    INSERT INTO web3.deal_terms VALUES('${u(10)}',31337,'${h(5)}','${u(60)}','${u(61)}',
      2640000000,now()+interval '1 day',now()+interval '10 days',now());`);
  pass('pre-funding terms persisted');
  await rejects(`UPDATE web3.deal_terms SET amount_atomic=1`,'pre-funding terms immutable');
  await db.exec(`INSERT INTO web3.intent_transactions VALUES('${u(40)}',31337,'${h(3)}')`);
  pass('intent transaction association');
  await rejects(`INSERT INTO web3.intent_transactions VALUES('${u(40)}',31337,'${h(99)}')`,'unknown transaction association rejected');
  await rejects(`INSERT INTO web3.outbox VALUES('${u(50)}','${u(999)}','intent','{}',0,now(),NULL)`,'outbox intent FK');
  await db.exec(`BEGIN;
    INSERT INTO web3.outbox VALUES('${u(50)}','${u(40)}','intent','{}',0,now(),NULL);
    ROLLBACK;`);
  assert.equal((await db.query('select count(*)::int as n from web3.outbox')).rows[0].n,0);
  pass('transactional outbox rollback');
  console.log(`DB checks: ${checks} passed; 0 failed. Engine: PGlite PostgreSQL WASM, not external server.`);
}finally{await db.close();}
