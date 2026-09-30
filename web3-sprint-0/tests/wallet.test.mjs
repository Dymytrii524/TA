import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFixture,h,a,u} from './p1-fixture.mjs';
import {replayWallet,authorizeWallet,prepareWithdrawal} from '../runtime/wallet.mjs';
let checks=0;
const test=(name,fn)=>{fn();console.log('PASS '+name);checks++};
const settled=(n,extra={})=>({kind:'Settled',blockHash:h(n),txHash:h(n),blockNumber:n,
  transactionIndex:0,logIndex:0,escrowId:h(n),dealId:u(n),payer:a(3),carrier:a(4),
  amount:'1000',payerAmount:'600',carrierAmount:'400',...extra});
const withdrawn=(n,extra={})=>({kind:'Withdrawn',blockHash:h(n),txHash:h(n),blockNumber:n,
  transactionIndex:0,logIndex:0,account:a(3),amount:'1200',...extra});
const one=settled(1),two=settled(2),out=withdrawn(3);
test('two deals -> one full sweep with exact allocations',()=>{
  const r=replayWallet([out,two,one]);assert.equal(r.withdrawals[0].allocations.length,2);
  assert.equal(r.balances[a(3)],'0');assert.equal(r.balances[a(4)],'800');
});
test('duplicate/restart replay is idempotent',()=>assert.deepEqual(replayWallet([one,two,out,one,out]),replayWallet([one,two,out])));
test('later claim is not allocated to earlier withdrawal',()=>assert.equal(replayWallet([one,two,out,settled(4)]).balances[a(3)],'600'));
test('same block follows transaction and log order',()=>{
  const b={blockNumber:10,blockHash:h(10)};
  assert.equal(replayWallet([withdrawn(13,{...b,transactionIndex:2}),settled(11,{...b}),settled(12,{...b,transactionIndex:1})]).withdrawals[0].allocations.length,2);
});
for(const [name,events] of [
  ['missing history',[one,out]],['wrong wallet',[one,two,withdrawn(3,{account:a(8)})]],
  ['overpayment',[one,two,withdrawn(3,{amount:'1201'})]],
  ['underpayment',[one,two,withdrawn(3,{amount:'1199'})]],
  ['duplicate settlement',[one,settled(2,{escrowId:one.escrowId})]],
  ['forged split',[settled(1,{payerAmount:'999'})]],
  ['bad atomic',[settled(1,{payerAmount:'NaN'})]],
  ['conflicting replay',[one,{...one,payerAmount:'601'}]],
  ['zero withdrawal',[withdrawn(3,{amount:'0'})]],
])test('reject '+name,()=>assert.throws(()=>replayWallet(events)));
test('pre-finality replay omits orphan branch',()=>assert.equal(replayWallet([one,two]).withdrawals.length,0));
test('refund/proceeds for same wallet are separately identified',()=>{
  const s=settled(2,{payer:a(4),carrier:a(5)});
  const r=replayWallet([one,s,withdrawn(3,{account:a(4),amount:'1000'})]);
  assert.deepEqual(r.lots.filter(l=>l.account===a(4)).map(l=>l.kind),['proceeds','refund']);
});
const {db,t}=await createFixture();
try{
  await db.query('INSERT INTO web3.wallet_permissions VALUES($1,$2,true)',[u(4),u(1)]);
  await authorizeWallet(db,u(4),u(60));checks++;
  await assert.rejects(()=>authorizeWallet(db,u(4),u(61)),/denied/);checks++;
  const snapshot={chain_id:31337,contract:t.contract,token:t.token,ledger:{balances:{[t.payer]:'1200'}}};
  const body={action:'withdraw',chain_id:31337},key='wallet-key-000001';
  const first=await prepareWithdrawal(db,u(4),u(60),key,body,snapshot);
  assert.equal(first.data,'0x3ccfd60b');
  assert.deepEqual(await prepareWithdrawal(db,u(4),u(60),key,body,snapshot),first);checks+=2;
  for(const bad of [{...body,deal_id:u(10)},{...body,from:a(8)},{...body,chain_id:80002},{...body,amount:'1'}]){
    await assert.rejects(()=>prepareWithdrawal(db,u(4),u(60),key,bad,snapshot));checks++;
  }
  await assert.rejects(()=>prepareWithdrawal(db,u(4),u(60),'short',body,snapshot));checks++;
  await assert.rejects(()=>prepareWithdrawal(db,u(4),u(60),'wallet-key-000002',body,{...snapshot,ledger:{balances:{}}}));checks++;
  await db.query('UPDATE web3.wallet_bindings SET revoked_at=now() WHERE id=$1',[u(60)]);
  await assert.rejects(()=>prepareWithdrawal(db,u(4),u(60),key,body,snapshot),/denied/);checks++;
  await db.query(`INSERT INTO web3.chain_transactions VALUES(31337,$1,'finalized',$2,1,true,now())`,[h(300),h(301)]);
  const add=(id,escrow,kind,payload)=>db.query(`INSERT INTO web3.chain_events
    (id,chain_id,tx_hash,block_hash,log_index,contract_address,escrow_id,event_kind,payload,finalized)
    VALUES($1,31337,$2,$3,$4,$5,$6,$7,$8::jsonb,true)`,
    [u(id),h(300),h(301),id,t.contract,escrow,kind,JSON.stringify(payload)]);
  await add(100,null,'Withdrawn',{account:t.payer,amount:'1200'});checks++;
  await add(101,null,'IntakePause',{paused:true});checks++;
  for(const [id,escrow,kind,payload] of [
    [102,null,'Settled',{}],[103,h(1),'Withdrawn',{account:t.payer,amount:'1'}],
    [104,null,'Withdrawn',{account:t.payer}],[105,null,'Withdrawn',{account:t.payer,amount:'NaN'}],
    [106,null,'Unknown',{}]]){
    await assert.rejects(()=>add(id,escrow,kind,payload));checks++;
  }
  await assert.rejects(()=>db.query(`INSERT INTO web3.intents
    (id,deal_id,actor_user_id,chain_id,action,idempotency_key,request_hash,status,expires_at)
    VALUES($1,$2,$3,31337,'withdraw','abcdefghijklmnop',$4,'prepared',now()+interval '1 hour')`,
    [u(900),u(10),u(4),h(90)]));checks++;
  console.log(`F05 wallet regression checks: ${checks} passed`);
}finally{await db.close()}
// Migration refusal is atomic and preserves previously populated history.
const historical=await createFixture({}, {applyWallet:false});
try{
  await historical.db.query(`INSERT INTO web3.intents
    (id,deal_id,actor_user_id,chain_id,action,idempotency_key,request_hash,status,expires_at)
    VALUES($1,$2,$3,31337,'withdraw','abcdefghijklmnop',$4,'prepared',now()+interval '1 hour')`,
    [u(900),u(10),u(4),h(90)]);
  await assert.rejects(()=>historical.db.exec(readFileSync('db/005_wallet_accounting.sql','utf8')),/backfill/);
  await historical.db.exec('ROLLBACK');
  assert.equal((await historical.db.query("SELECT to_regclass('web3.wallet_reconciliations') AS t")).rows[0].t,null);
  console.log('PASS F05 populated migration refusal and atomic rollback');
}finally{await historical.db.close()}
