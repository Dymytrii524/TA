// R21-04 regressions: real local chain + immutable SQL, not clock mocks.
// Dedicated Anvil must start >=600 seconds in the past. Each scenario restores
// its local chain snapshot; no external chain and no production database.
import assert from 'node:assert/strict';
import {JsonRpcProvider} from 'ethers';
import {createServer} from 'node:http';
import {r21Fixture,hash} from './r21-fixture.mjs';
import {u} from './p1-fixture.mjs';
import {recordMappingPreflight,verifyMappingPreflight} from '../runtime/mapping-evidence.mjs';
import {reconcileWallet,walletHandler} from '../runtime/wallet.mjs';
import {reconcileWallet as reconcileV1} from './fixtures/v1/runtime/wallet.mjs';
import {classify} from '../runtime/subsets.mjs';
const url=process.env.ANVIL_URL;
assert(url&&['localhost','127.0.0.1'].includes(new URL(url).hostname),'dedicated LOCAL Anvil required');
const control=new JsonRpcProvider(url,31337,{staticNetwork:true,cacheTimeout:-1});
let saved=await control.send('evm_snapshot',[]),checks=0;
const pass=s=>{checks++;console.log('PASS R21-04 '+s)};
async function scenario(fn,options){
  const f=await r21Fixture(options);
  try{await fn(f)}finally{
    await f.close();
    assert.equal(await control.send('evm_revert',[saved]),true);
    saved=await control.send('evm_snapshot',[]);
  }
}
async function fund(f,offset=0){
  const terms=(await f.db.query('SELECT * FROM web3.deal_terms WHERE deal_id=$1',[u(10)])).rows[0];
  const second=Math.floor(new Date(terms.frozen_at).getTime()/1000)+offset;
  assert(Number((await f.rpc.send('eth_getBlockByNumber',['latest',false])).timestamp)<second,
    'start dedicated Anvil with --timestamp now-600');
  await f.rpc.send('evm_setNextBlockTimestamp',[second]);
  const receipt=await f.send(f.escrow.create(f.t.nonce,f.addr[1],f.t.amount,f.t.acceptBy,f.t.deliveryBy,f.t.agreement,2));
  await f.send(f.escrow.connect(f.s[1]).cancelUnaccepted(f.t.id));await f.mine();
  return {terms,receipt,second};
}
try{
  for(const offset of [-120,0,120]){
    await scenario(async f=>{
      const {terms,receipt,second}=await fund(f,offset);
      const before=JSON.stringify((await f.db.query('SELECT * FROM web3.mapping_preflight')).rows);
      assert.equal((await recordMappingPreflight(f.db,f.rpc,u(10))).deal_id,u(10),'idempotent after funding');
      assert.equal(JSON.stringify((await f.db.query('SELECT * FROM web3.mapping_preflight')).rows),before);
      const snapshot=await reconcileWallet(f.db,f.rpc,31337);
      assert.equal(snapshot.ledger.ta_balances[f.t.payer],'600');
      assert.equal(snapshot.ledger.classifications[0].provenance,'TA_MATCHED');
      const fact={escrowId:f.t.id,token:f.t.token,payer:f.t.payer,carrier:f.t.carrier,
        termsHash:f.t.termsHash,amount:f.t.amount,timestamp:second,
        blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,txHash:receipt.hash,logIndex:0};
      const proof=(await f.db.query('SELECT * FROM web3.mapping_preflight')).rows[0];
      assert.equal(await verifyMappingPreflight(f.rpc,proof,terms,fact),true);
      for(const invalid of [{...proof,block_number:receipt.blockNumber},{...proof,block_hash:hash('orphan')},
        {...proof,terms_hash:hash('wrong')},{...proof,chain_id:80002},{...proof,contract_address:f.t.token}]){
        await assert.rejects(()=>verifyMappingPreflight(f.rpc,invalid,terms,fact),/preflight/);
      }
      assert.equal(classify(terms,fact,{provenance:'UNATTRIBUTED'},[],{preflight:true}).dealId,null,
        'existing quarantine cannot be silently upgraded');
      assert.equal(classify(terms,fact,null,[]).dealId,null,'timestamps alone never prove mapping');
      for(const sql of ['UPDATE web3.mapping_preflight SET block_number=0','DELETE FROM web3.mapping_preflight',
        'TRUNCATE web3.mapping_preflight','TRUNCATE web3.deal_terms CASCADE']){
        await assert.rejects(()=>f.db.exec(sql),/append-only/);
      }
      const server=createServer(walletHandler({db:f.db,rpc:f.rpc,authenticate:async()=>({id:u(4)})}));
      await new Promise(r=>server.listen(0,'127.0.0.1',r));
      try{
        const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v1/web3/wallets/${u(60)}/claims`);
        assert.equal(response.status,200);assert.equal((await response.json()).ta_claimable_atomic,'600');
      }finally{server.closeAllConnections();await new Promise(r=>server.close(r))}
      pass(`pre-funding proof, clock offset ${offset}s, HTTP 200, immutable/scoped/orphan guards`);
    });
  }
  await scenario(async f=>{
    await fund(f);
    // Unchanged actual V1 reconciler from bad53cc, not a synthetic V2 conversion.
    const v1=await reconcileV1(f.db,f.rpc,31337);
    assert.equal(v1.ledger.lots[0].deal_id,u(10));assert.equal(v1.ledger.balances[f.t.payer],'600');
    const before=JSON.stringify((await f.db.query('SELECT * FROM web3.wallet_reconciliations')).rows);
    assert.equal((await f.db.query('SELECT * FROM web3.mapping_preflight')).rows.length,0);
    const corrupt={transaction:fn=>f.db.transaction(tx=>fn({query:async(sql,args)=>{
      const result=await tx.query(sql,args);
      if(sql.startsWith('SELECT * FROM web3.wallet_reconciliations'))result.rows[0].subledger.balances[f.t.payer]='999';
      return result;
    }}))};
    await assert.rejects(()=>reconcileWallet(corrupt,f.rpc,31337),/legacy backfill mismatch/);
    assert.equal((await f.db.query('SELECT * FROM web3.wallet_active_snapshot')).rows.length,0);
    assert.equal((await f.db.query('SELECT * FROM web3.wallet_snapshots_v2')).rows.length,0);
    const snapshot=await reconcileWallet(f.db,f.rpc,31337);
    assert.equal(snapshot.ledger.ta_balances[f.t.payer],'600');
    assert.equal((await reconcileWallet(f.db,f.rpc,31337)).ledger.ta_balances[f.t.payer],'600',
      'validated attribution survives subsequent V2 replay');
    assert.equal(JSON.stringify((await f.db.query('SELECT * FROM web3.wallet_reconciliations')).rows),before);
    pass('real populated V1 -> V2 at same second, no approval, immutable history, corrupt refusal atomic');
  },{preflight:false});
  await scenario(async f=>{
    await fund(f);
    await assert.rejects(()=>recordMappingPreflight(f.db,f.rpc,u(10)),/funding already exists/);
    assert.equal((await f.db.query('SELECT * FROM web3.mapping_preflight')).rows.length,0);
    const snapshot=await reconcileWallet(f.db,f.rpc,31337);
    assert.equal(snapshot.ledger.unattributed_balances[f.t.payer],'600');
    assert.equal(snapshot.ledger.ta_balances[f.t.payer],undefined);
    pass('missing proof cannot be manufactured after funding; no automatic TA attribution');
  },{preflight:false});
  await scenario(async f=>{
    const proxy=(fn)=>({send:fn});
    await assert.rejects(()=>recordMappingPreflight(f.db,proxy(async(m,a)=>m==='eth_chainId'?'0x89':f.rpc.send(m,a)),u(10)),/chain mismatch/);
    await assert.rejects(()=>recordMappingPreflight(f.db,proxy(async(m,a)=>m==='eth_getCode'?'0x':f.rpc.send(m,a)),u(10)),/code mismatch/);
    let blockReads=0;
    await assert.rejects(()=>recordMappingPreflight(f.db,proxy(async(m,a)=>{
      const r=await f.rpc.send(m,a);
      return m==='eth_getBlockByNumber'&&++blockReads===2?{...r,hash:hash('changed')}:r;
    }),u(10)),/anchor changed/);
    assert.equal((await f.db.query('SELECT * FROM web3.mapping_preflight')).rows.length,0);
    await assert.rejects(()=>f.db.query(`INSERT INTO web3.mapping_preflight
      (deal_id,chain_id,contract_address,escrow_id,terms_hash,block_number,block_hash)
      VALUES($1,31337,$2,$3,$4,1,$5)`,[u(10),f.t.contract,f.t.id,hash('wrong'),hash('block')]),/scope mismatch/);
    if(process.env.WEB3_TEST_DATABASE_URL){
      await Promise.all([recordMappingPreflight(f.db,f.rpc,u(10)),recordMappingPreflight(f.db,f.rpc,u(10))]);
      assert.equal((await f.db.query('SELECT * FROM web3.mapping_preflight')).rows.length,1);
    }
    pass('wrong RPC chain/code/changing anchor and SQL scope rejected; no partial evidence');
  },{preflight:false});
  console.log(JSON.stringify({checks,engine:process.env.WEB3_TEST_DATABASE_URL?'PostgreSQL':'PGlite'}));
}finally{control.destroy()}
