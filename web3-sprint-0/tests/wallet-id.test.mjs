// R21-05: actual HTTP on both endpoints; malformed IDs never reach SQL/RPC.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawnSync} from 'node:child_process';
import {walletHandler,authorizeWallet,prepareWithdrawal} from '../runtime/wallet.mjs';
import {r21Fixture} from './r21-fixture.mjs';
import {u} from './p1-fixture.mjs';
const f=await r21Fixture();
let queries=0,transactions=0,calls=0,mode='',auth=true;
const db={
  query:(...a)=>{queries++;if(mode==='db')throw Error('private SQL failure');return f.db.query(...a)},
  transaction:fn=>{transactions++;return f.db.transaction(fn)}
};
const rpc={send:(...a)=>{calls++;if(mode==='rpc')throw Error('private RPC failure');return f.rpc.send(...a)}};
const audit=[],problems=[];
const server=createServer(walletHandler({db,rpc,authenticate:async()=>auth?{id:u(4)}:null,audit:x=>audit.push(x)}));
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}/api/v1/web3/wallets/`;
async function request(id,endpoint='claims'){
  const r=await fetch(base+id+'/'+endpoint,{method:endpoint==='claims'?'GET':'POST',
    headers:{'Content-Type':'application/json','Idempotency-Key':'r21-05-regression'},
    ...(endpoint==='intents'?{body:JSON.stringify({action:'withdraw',chain_id:31337})}:{})});
  const body=await r.json();
  if(r.status>=400)problems.push({status:r.status,body});
  return {status:r.status,body};
}
const malformed=['-'.repeat(36),'f'.repeat(36),'g'.repeat(36),
  '0000000-00000-4000-8000-000000000060','00000000-0000-4000-8000-00000000006z',
  u(60)+'0',u(60).slice(1),'%20'+u(60),u(60)+'%00','{'+u(60)+'}','%2F'];
try{
  for(const id of malformed){
    for(const endpoint of ['claims','intents']){
      const before=[queries,transactions,calls,audit.length];
      const r=await request(id,endpoint);
      assert.equal(r.status,404,`${id}/${endpoint}`);
      assert.equal(r.body.code,'not found');
      assert.deepEqual([queries,transactions,calls,audit.length],before,'invalid path must not touch DB/RPC/audit');
    }
    const before=[queries,transactions,calls];
    await assert.rejects(()=>authorizeWallet(db,u(4),id),e=>e.status===422&&e.message==='invalid wallet binding id');
    await assert.rejects(()=>prepareWithdrawal(db,u(4),id,'r21-05-regression',
      {action:'withdraw',chain_id:31337},{}),e=>e.status===422&&e.message==='invalid wallet binding id');
    assert.deepEqual([queries,transactions,calls],before,'direct helpers reject before transaction/SQL');
  }
  console.log(`PASS R21-05 ${malformed.length*2} malformed HTTP paths + ${malformed.length*2} direct helper negatives, zero DB/RPC`);
  for(const id of [null,undefined,{},36,u(60)+'\n',u(60)+'\r']){
    const before=[queries,transactions,calls];
    await assert.rejects(()=>authorizeWallet(db,u(4),id),e=>e.status===422);
    await assert.rejects(()=>prepareWithdrawal(db,u(4),id,'r21-05-regression',{},{}),e=>e.status===422);
    assert.deepEqual([queries,transactions,calls],before);
  }
  console.log('PASS R21-05 12 direct-helper type/trailing-newline negatives before persistence');
  auth=false;
  assert.equal((await request('-'.repeat(36))).status,401);auth=true;
  assert.equal((await request(u(999))).status,403);
  assert.equal((await request(u(61),'intents')).status,403);
  await f.send(f.escrow.create(f.t.nonce,f.addr[1],f.t.amount,f.t.acceptBy,f.t.deliveryBy,f.t.agreement,2));
  await f.send(f.escrow.connect(f.s[1]).cancelUnaccepted(f.t.id));await f.mine();
  assert.equal((await request(u(60))).status,200);
  assert.equal((await request(u(60),'intents')).status,201);
  // UUID hexadecimal case is accepted, not silently treated as malformed.
  const caseId='abcdefab-abcd-4abc-8abc-abcdefabcdef';
  const before=queries;
  assert.equal((await request(caseId.toUpperCase())).status,403);
  assert(queries>before);
  for(mode of ['db','rpc']){
    for(const endpoint of ['claims','intents']){
      const r=await request(u(60),endpoint);
      assert.equal(r.status,503);assert.equal(r.body.code,'RECONCILIATION_UNAVAILABLE');
      assert(!JSON.stringify(r).includes('private'));
    }
  }
  mode='';
  assert.equal((await request(u(60))).status,200);
  const validation=spawnSync('python',['tools/validate_problem_response.py'],{input:JSON.stringify(problems),encoding:'utf8'});
  assert.equal(validation.status,0,validation.stderr);console.log(validation.stdout.trim());
  console.log('PASS R21-05 healthy 200/201, auth 401/403, case-insensitive UUID, real DB/RPC failures still sanitized 503');
}finally{
  server.closeAllConnections();await new Promise(r=>server.close(r));await f.close();
}
