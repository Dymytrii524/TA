import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawnSync} from 'node:child_process';
import {walletHandler} from '../runtime/wallet.mjs';
import {r21Fixture,hash} from './r21-fixture.mjs';
import {u} from './p1-fixture.mjs';
const f=await r21Fixture();const {db,rpc,t,escrow,addr,s,send,mine,create}=f;
let mode='',n=0;const audit=[],responses=[];
const pass=s=>{n++;console.log('PASS R21-03 '+s)};
const proxyRpc={send:async(m,a)=>{
  if(mode==='status-spoof')throw Object.assign(Error('SQL password=secret at private-internal-url'),{status:409});
  if(mode==='chain'&&m==='eth_chainId')return '0x89';
  if(mode==='code'&&m==='eth_getCode')return '0x00';
  if(mode==='receipt'&&m==='eth_getTransactionReceipt')return null;
  if(mode==='anchor'&&m==='eth_getBlockByNumber')return {...await rpc.send(m,a),hash:hash('invalid-block')};
  return rpc.send(m,a);
}};
const proxyDB={
  query:(...a)=>{if(mode==='db')throw Object.assign(Error('DB password=secret'),{status:422});return db.query(...a)},
  transaction:fn=>db.transaction(tx=>fn({query:async(sql,args)=>{
    const r=await tx.query(sql,args);
    if(mode==='history'&&sql.includes('FROM web3.chain_transactions')&&r.rows[0])r.rows[0].block_number='99999999';
    return r;
  }}))
};
const server=createServer(walletHandler({db:proxyDB,rpc:proxyRpc,
  authenticate:async req=>req.headers.authorization==='Bearer fixture'?{id:u(4)}:null,
  audit:x=>audit.push(x)}));
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}/api/v1/web3`;
const request=async({path=`/wallets/${u(60)}/claims`,method='GET',body,auth=true,key='r21-errors-000001'}={})=>{
  const r=await fetch(base+path,{method,headers:{...(auth?{Authorization:'Bearer fixture'}:{}),
    'Content-Type':'application/json','Idempotency-Key':key},...(body!==undefined?{body}: {})});
  const value=await r.json();
  if(r.status>=400){
    assert(r.headers.get('content-type').startsWith('application/problem+json'));
    assert.equal(value.status,r.status);responses.push({status:r.status,body:value});
  }
  return {status:r.status,body:value};
};
const intent={path:`/wallets/${u(60)}/intents`,method:'POST',body:JSON.stringify({action:'withdraw',chain_id:31337})};
try{
  await send(escrow.create(t.nonce,addr[1],t.amount,t.acceptBy,t.deliveryBy,t.agreement,2));
  await send(escrow.connect(s[1]).cancelUnaccepted(t.id));await mine();
  assert.equal((await request()).status,200);
  const count=async()=>Number((await db.query('SELECT count(*) n FROM web3.wallet_snapshots_v2')).rows[0].n);
  const before=await count();
  for(mode of ['history','chain','code','receipt','anchor','status-spoof','db']){
    for(const q of [{},intent]){
      const r=await request(q);assert.equal(r.status,503,mode);
      assert.equal(r.body.code,'RECONCILIATION_UNAVAILABLE');
      assert.equal(r.body.title,'Reconciliation unavailable');
      assert.match(r.body.correlation_id,/^[0-9a-f-]{36}$/);
      assert(!JSON.stringify(r).includes('secret'));assert(!JSON.stringify(r).includes('SQL'));
    }
  }
  mode='';assert.equal(await count(),before);
  assert.equal(Number((await db.query('SELECT count(*) n FROM web3.intents')).rows[0].n),0);
  pass('internal failures -> stable 503, no stale success or partial intent');
  assert.equal(audit.length,14);assert(audit.every(x=>x.correlation_id&&x.event==='web3.reconciliation_failed'));
  assert(!JSON.stringify(audit).includes('secret'));pass('protected correlation audit excludes downstream messages');
  assert.equal((await request({auth:false})).status,401);
  assert.equal((await request({path:`/wallets/${u(61)}/claims`})).status,403);pass('401/403 remain domain errors');
  assert.equal((await request({path:'/missing'})).status,404);
  assert.equal((await request({method:'PUT'})).status,405);
  assert.equal((await request({...intent,body:'{'})).status,422);
  assert.equal((await request({...intent,body:'x'.repeat(4097)})).status,413);
  assert.equal((await request({...intent,body:JSON.stringify({action:'withdraw',chain_id:31337,from:addr[5]})})).status,422);
  pass('404/405/413/422 preserved');
  assert.equal((await request(intent)).status,201);
  await db.query('UPDATE web3.intents SET request_hash=$1',[hash('different')]);
  assert.equal((await request(intent)).status,409);pass('idempotency conflict remains 409');
  const external=await create(hash('http-external'),400);await external.settle();await mine();
  const claims=await request();assert.equal(claims.status,200);
  assert.equal(claims.body.unattributed_claimable_atomic,'400');
  assert.equal((await request({...intent,key:'r21-errors-000002'})).status,201);pass('verified quarantine is 200/201, not 503');
  await send(escrow.withdraw());await mine();
  assert.equal((await request({...intent,key:'r21-errors-000003'})).status,409);pass('no finalized claim remains domain 409');
  await db.query('UPDATE web3.wallet_bindings SET revoked_at=now() WHERE id=$1',[u(60)]);
  assert.equal((await request(intent)).status,403);pass('revoked retry denied');
  const validation=spawnSync('python',['tools/validate_problem_response.py'],{input:JSON.stringify(responses),encoding:'utf8'});
  assert.equal(validation.status,0,validation.stderr);console.log(validation.stdout.trim());
  pass('complete real problem responses validate');
  console.log(JSON.stringify({checks:n,responses:responses.length}));
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));await f.close()}
