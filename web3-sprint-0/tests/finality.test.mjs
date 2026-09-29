import assert from 'node:assert/strict';
import {createFixture,h,u} from './p1-fixture.mjs';
import {persistVerifiedTransaction,persistVerifiedEvent} from '../runtime/finality.mjs';
import {postgresFixtureDB} from './pg-adapter.mjs';
const external=process.env.WEB3_TEST_DATABASE_URL;
const {db,t}=await createFixture({},external?{db:await postgresFixtureDB()}:{});
const rpc={send:async()=>({hash:h(800)})};
let n=0;const pass=s=>{n++;console.log('PASS R21-01 '+s)};
const event=i=>({txHash:h(i),blockHash:h(i+100),blockNumber:i,kind:'Settled',
  escrowId:t.id,logIndex:0,transactionIndex:0,payerAmount:'600',carrierAmount:'400'});
const insert=(e,state,block=e.blockHash,success=true)=>db.query(`INSERT INTO web3.chain_transactions
 (chain_id,tx_hash,state,block_hash,block_number,receipt_success)
 VALUES(31337,$1,$2,$3,$4,$5)`,[e.txHash,state,block,state==='submitted'?null:e.blockNumber,state==='submitted'?null:success]);
const promote=e=>db.transaction(async tx=>{
  await persistVerifiedTransaction(tx,rpc,31337,e);
  await persistVerifiedEvent(tx,31337,t.contract,e);
});
try{
  for(const [i,state] of [[1,'included'],[2,'submitted']]){
    const e=event(i);await insert(e,state,state==='submitted'?null:e.blockHash);
    await promote(e);assert.equal((await db.query('SELECT state FROM web3.chain_transactions WHERE tx_hash=$1',[e.txHash])).rows[0].state,'finalized');
    pass(state+' -> finalized atomic');
  }
  await promote(event(1));assert.equal(Number((await db.query('SELECT count(*) n FROM web3.chain_events')).rows[0].n),2);
  pass('finalized replay no UPDATE/no duplicate');
  await assert.rejects(()=>promote({...event(1),blockNumber:99}),/history conflict/);pass('finalized height conflict');
  await assert.rejects(()=>promote({...event(1),blockHash:h(999)}),/history conflict/);pass('finalized hash conflict');
  const e=event(3);await insert(e,'included',h(700));await promote(e);
  assert.equal((await db.query('SELECT previous FROM web3.transaction_observations WHERE tx_hash=$1',[e.txHash])).rows[0].previous.block_hash,h(700));
  pass('proven pre-finality reorg retains observation');
  const bad=event(4);await insert(bad,'failed',h(800),false);
  await assert.rejects(()=>promote(bad),/unproven/);pass('canonical failure not promoted');
  const e5=event(5);await insert(e5,'orphaned',h(700));await promote(e5);pass('orphan re-inclusion newly verified');
  const e6=event(6);await insert(e6,'submitted',null);
  await assert.rejects(()=>db.transaction(async tx=>{await persistVerifiedTransaction(tx,rpc,31337,e6);throw Error('injected')}),/injected/);
  assert.equal((await db.query('SELECT state FROM web3.chain_transactions WHERE tx_hash=$1',[e6.txHash])).rows[0].state,'submitted');
  pass('fault after promotion rolls back');
  await db.query(`INSERT INTO web3.chain_events
    (id,chain_id,tx_hash,block_hash,log_index,contract_address,escrow_id,event_kind,payload,finalized)
    VALUES($1,31337,$2,$3,0,$4,$5,'Settled',$6::jsonb,false)`,
    [u(300),e6.txHash,e6.blockHash,t.contract,t.id,JSON.stringify({payerAmount:'600',carrierAmount:'400',transactionIndex:0})]);
  await promote(e6);
  assert.equal((await db.query('SELECT finalized FROM web3.chain_events WHERE id=$1',[u(300)])).rows[0].finalized,true);
  pass('existing non-final event promotes with tx');
  await assert.rejects(()=>promote({...e6,payerAmount:'999'}),/event history conflict/);pass('conflicting finalized payload halts');
  if(external){
    const e7=event(7);await insert(e7,'submitted',null);
    // Two real PostgreSQL sessions race for one row, not PGlite promises.
    await Promise.all([promote(e7),promote(e7)]);
    assert.equal(Number((await db.query('SELECT count(*) n FROM web3.transaction_observations WHERE tx_hash=$1',[e7.txHash])).rows[0].n),1);
    assert.equal(Number((await db.query('SELECT count(*) n FROM web3.chain_events WHERE tx_hash=$1',[e7.txHash])).rows[0].n),1);
    pass('two PostgreSQL workers exactly once');
  }
  console.log(JSON.stringify({checks:n,engine:external?'PostgreSQL':'PGlite'}));
}finally{await db.close()}
