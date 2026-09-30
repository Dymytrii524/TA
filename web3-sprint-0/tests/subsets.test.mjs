import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {reconcileWallet,walletHandler,replayWallet} from '../runtime/wallet.mjs';
import {classify,legacyLedger,readHistory,publicWallet} from '../runtime/subsets.mjs';
import {r21Fixture,hash} from './r21-fixture.mjs';
import {u,freeze} from './p1-fixture.mjs';
import {deriveEscrowId,deriveTermsHash} from '../tools/escrow-identity.mjs';
const f=await r21Fixture();const {db,t,rpc,send,escrow,token,s,addr,mine,create}=f;
let server,n=0;const pass=s=>{n++;console.log('PASS R21-02 '+s)};
const schemas=[];
try{
  await send(escrow.create(t.nonce,addr[1],t.amount,t.acceptBy,t.deliveryBy,t.agreement,2));
  const settled=await send(escrow.connect(s[1]).cancelUnaccepted(t.id));await mine();
  let snap=await reconcileWallet(db,rpc,31337);
  assert.equal(snap.ledger.ta_balances[t.payer],'600');
  // Valid V1 history can be independently replayed into V2 without rewriting it.
  await db.query(`INSERT INTO web3.wallet_reconciliations
    (id,chain_id,contract_address,token_address,block_number,block_hash,policy_version,subledger)
    VALUES($1,31337,$2,$3,$4,$5,'F05-B/1',$6::jsonb)`,
    [u(990),t.contract,t.token,snap.block_number,snap.block_hash,JSON.stringify(legacyLedger(snap.ledger))]);
  const v1Before=(await db.query('SELECT subledger FROM web3.wallet_reconciliations')).rows;
  // Pointer reset is a test-only simulation of first V2 activation, not history deletion.
  await db.query('DELETE FROM web3.wallet_active_snapshot');await reconcileWallet(db,rpc,31337);
  assert.deepEqual((await db.query('SELECT subledger FROM web3.wallet_reconciliations')).rows,v1Before);
  pass('populated V1 replay preserves old snapshots');
  server=createServer(walletHandler({db,rpc,authenticate:async req=>req.headers.authorization==='Bearer fixture'?{id:u(4)}:null}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}/api/v1/web3/wallets/${u(60)}`;
  const req=(body,path='claims')=>fetch(base+'/'+path,{method:body?'POST':'GET',
    headers:{Authorization:'Bearer fixture','Idempotency-Key':'r21-intent-000001','Content-Type':'application/json'},
    ...(body?{body:JSON.stringify(body)}:{})});
  const outside=await create(hash('outside-independent'),1,5,6);await outside.settle();await mine();
  let r=await req();assert.equal(r.status,200);let claims=await r.json();schemas.push(claims);
  assert.equal(claims.ta_claimable_atomic,'600');assert.equal(claims.claimable_atomic,'600');
  assert.equal((await req({action:'withdraw',chain_id:31337},'intents')).status,201);
  pass('one atomic outsider preserves independent wallet HTTP and intent');
  const mixed=await create(hash('mixed'),400);await mixed.settle();await mine();
  claims=await(await req()).json();schemas.push(claims);
  assert.equal(claims.claimable_atomic,'1000');assert.equal(claims.ta_claimable_atomic,'600');
  assert.equal(claims.unattributed_claimable_atomic,'400');
  assert.deepEqual(claims.warnings,['WITHDRAW_ALL_INCLUDES_UNATTRIBUTED']);pass('mixed wallet exact partitions and warning');
  // Current signed-intent amount is intentionally not a guaranteed quote.
  const late=await create(hash('later-external'),200);await late.settle();await mine();
  const withdrawal=await send(escrow.withdraw());
  await db.query("INSERT INTO web3.chain_transactions(chain_id,tx_hash,state) VALUES(31337,$1,'submitted')",[withdrawal.hash]);
  await mine();snap=await reconcileWallet(db,rpc,31337);
  const paid=snap.ledger.withdrawals.find(w=>w.account===t.payer);
  assert.equal(paid.amount_atomic,'1200');
  assert.equal(paid.allocations.filter(a=>a.deal_id).reduce((n,a)=>n+BigInt(a.amount_atomic),0n),600n);
  assert.equal(paid.allocations.filter(a=>!a.deal_id).reduce((n,a)=>n+BigInt(a.amount_atomic),0n),600n);
  assert.equal((await db.query('SELECT state FROM web3.chain_transactions WHERE tx_hash=$1',[withdrawal.hash])).rows[0].state,'finalized');
  schemas.push(await(await req()).json());pass('actual full sweep allocates TA and later external lots once');
  const count=async()=>Number((await db.query('SELECT count(*) n FROM web3.wallet_snapshots_v2')).rows[0].n);
  const before=await count();await reconcileWallet(db,rpc,31337);assert.equal(await count(),before);pass('restart no duplicate snapshot');
  const only=await create(hash('only-external'),400);await only.settle();await mine();
  claims=await(await req()).json();assert.equal(claims.ta_claimable_atomic,'0');assert.equal(claims.unattributed_claimable_atomic,'400');
  const newIntent=await fetch(base+'/intents',{method:'POST',headers:{Authorization:'Bearer fixture','Idempotency-Key':'r21-intent-000002','Content-Type':'application/json'},body:JSON.stringify({action:'withdraw',chain_id:31337})});
  assert.equal(newIntent.status,201);schemas.push(claims);pass('unattributed-only authorized withdraw intent');
  const snapshot=await reconcileWallet(db,rpc,31337);
  // Pure late mapping checks require exact terms and explicit dual approval.
  const chainFact={escrowId:t.id,token:t.token,payer:t.payer,carrier:t.carrier,amount:t.amount,termsHash:t.termsHash,timestamp:0};
  const terms=(await db.query('SELECT * FROM web3.deal_terms')).rows[0];
  assert.equal(classify(terms,chainFact,{provenance:'UNATTRIBUTED'},[]).dealId,null);
  const approved=classify(terms,chainFact,{provenance:'UNATTRIBUTED'},[{escrow_id:t.id,deal_id:terms.deal_id}]);
  assert.equal(approved.dealId,terms.deal_id);
  assert.throws(()=>classify({...terms,terms_hash:hash('wrong')},chainFact,null,[]),/TA_MISMATCH/);
  pass('late mapping never automatic; exact hash required');
  await db.query('INSERT INTO public.users VALUES($1)',[u(5)]);
  await assert.rejects(()=>db.query(`INSERT INTO web3.wallet_mapping_approvals
    VALUES($1,31337,$2,$3,$4,$5,$6,$6,now())`,[u(991),t.contract,t.id,u(10),hash('proof'),u(4)]));
  await assert.rejects(()=>db.query(`INSERT INTO web3.wallet_mapping_approvals
    VALUES($1,31337,$2,$3,$4,$5,$6,$7,now())`,[u(991),t.contract,hash('wrong-scope'),u(10),hash('proof'),u(4),u(5)]),/scope/);
  pass('same approver and wrong scope forbidden by SQL');
  // Genuine late mapping AFTER payout. Same event/lot/withdrawal identities.
  const lateTerms={...t,nonce:hash('mixed'),agreement:hash('r21-external'),amount:'400'};
  lateTerms.id=deriveEscrowId(lateTerms.chainId,lateTerms.contract,lateTerms.payer,lateTerms.nonce);
  lateTerms.termsHash=deriveTermsHash(lateTerms);
  await db.query(`INSERT INTO web3.deals SELECT $1,payer_company_id,carrier_company_id,
    price_amount,price_currency,contract_currency,fx_rate,fx_source,fx_fixed_at,fx_expires_at,
    $3,created_at FROM web3.deals WHERE id=$2`,[u(11),u(10),lateTerms.agreement]);
  await freeze(db,lateTerms,u(11));
  const beforeMapping=await reconcileWallet(db,rpc,31337);
  assert.equal(beforeMapping.ledger.lots.find(l=>l.escrow_id===lateTerms.id).deal_id,null);
  const oldRevision=beforeMapping.projection_revision;
  await db.query(`INSERT INTO web3.wallet_mapping_approvals
    VALUES($1,31337,$2,$3,$4,$5,$6,$7,now())`,
    [u(992),t.contract,lateTerms.id,u(11),hash('verified-restore-evidence'),u(4),u(5)]);
  const mapped=await reconcileWallet(db,rpc,31337);
  assert.equal(mapped.projection_revision,oldRevision+1);
  assert.equal(mapped.ledger.lots.find(l=>l.escrow_id===lateTerms.id).deal_id,u(11));
  assert.equal(mapped.ledger.withdrawals.find(w=>w.account===t.payer).amount_atomic,'1200');
  assert.equal(mapped.ledger.lots.find(l=>l.escrow_id===lateTerms.id).id,
    beforeMapping.ledger.lots.find(l=>l.escrow_id===lateTerms.id).id);
  const historical=(await db.query(`SELECT subledger FROM web3.wallet_snapshots_v2
    WHERE projection_revision=$1 AND block_hash=$2`,[oldRevision,beforeMapping.block_hash])).rows[0].subledger;
  assert.equal(historical.lots.find(l=>l.escrow_id===lateTerms.id).deal_id,null);
  pass('late mapping after payout creates new revision, no rewrite or second payout');
  const redacted=publicWallet(snapshot,{wallet_address:t.payer,company_id:u(999)});
  assert(redacted.lots.every(l=>l.deal_id===null));assert(!JSON.stringify(redacted).includes(u(10)));
  assert(!JSON.stringify(redacted).includes(addr[5].toLowerCase()));pass('other-company TA references and other-wallet details not disclosed');
  // Donation is not a claim.
  await send(token.transfer(t.contract,7));await mine();
  assert.equal((await reconcileWallet(db,rpc,31337)).ledger.balances[t.payer],'400');pass('donation does not create a lot');
  const badRpc=(fn)=>({send:(m,a)=>fn(m,a)});
  const goodCount=await count();
  await assert.rejects(()=>reconcileWallet(db,badRpc(async(m,a)=>{
    if(m==='eth_getLogs')return (await rpc.send(m,a)).filter(l=>l.transactionHash!==outside.receipt.hash);
    return rpc.send(m,a);
  }),31337),/missing verified funding/);
  await assert.rejects(()=>reconcileWallet(db,badRpc(async(m,a)=>m==='eth_getTransactionReceipt'?{...await rpc.send(m,a),status:'0x0'}:rpc.send(m,a)),31337),/failed receipt/);
  assert.equal(await count(),goodCount);pass('missing external Funded or receipt never skipped; atomic refusal');
  if(process.env.WEB3_TEST_DATABASE_URL){
    const beforeRace=await count();
    await Promise.all([reconcileWallet(db,rpc,31337),reconcileWallet(db,rpc,31337)]);
    assert.equal(await count(),beforeRace);pass('two PostgreSQL reconcilers publish once');
  }
  const active=(await db.query('SELECT * FROM web3.wallet_active_snapshot')).rows[0];
  await db.query('DELETE FROM web3.wallet_active_snapshot');
  const corruptDb={transaction:fn=>db.transaction(tx=>fn({query:async(sql,args)=>{
    const r=await tx.query(sql,args);
    if(sql.startsWith('SELECT * FROM web3.wallet_reconciliations'))r.rows[0].subledger.balances[t.payer]='999999';
    return r;
  }}))};
  const preRefusal=await count();
  await assert.rejects(()=>reconcileWallet(corruptDb,rpc,31337),/legacy backfill mismatch/);
  assert.equal(await count(),preRefusal);assert.equal((await db.query('SELECT * FROM web3.wallet_active_snapshot')).rows.length,0);
  await db.query('INSERT INTO web3.wallet_active_snapshot VALUES($1,$2,$3)',[active.chain_id,active.contract_address,active.snapshot_id]);
  pass('corrupt legacy backfill refuses active pointer atomically');
  await assert.rejects(()=>db.query('UPDATE web3.wallet_snapshots_v2 SET projection_revision=99'),/append-only/);
  await assert.rejects(()=>db.exec('TRUNCATE web3.wallet_mapping_approvals'),/append-only/);pass('V2 audit immutable');
  // Batch coverage/retry test does not claim to measure production throughput.
  const ranges=[];let failed=false;
  const batchRpc={send:async(_,[q])=>{
    if(!failed){failed=true;throw Error('retry this range')}
    ranges.push([Number(q.fromBlock),Number(q.toBlock)]);
    return Array.from({length:Number(q.toBlock)-Number(q.fromBlock)+1},(_,i)=>({blockNumber:Number(q.fromBlock)+i}));
  }};
  const logs=await readHistory(batchRpc,t.contract,0,999,[],{batch:100});
  assert.equal(logs.length,1000);assert.equal(ranges.length,10);
  await assert.rejects(()=>readHistory({send:async()=>{throw Error('RPC down')}},t.contract,0,10,[]),/RPC down/);
  pass('1000-event bounded batches, same-range retry, no skip on failure');
  const e={kind:'Settled',blockHash:hash('b'),txHash:hash('x'),blockNumber:1,transactionIndex:0,logIndex:0,
    escrowId:hash('e'),dealId:null,payer:t.payer,carrier:t.carrier,amount:'1000',payerAmount:'1000',carrierAmount:'0'};
  assert.throws(()=>replayWallet([e,{kind:'Withdrawn',blockHash:hash('b2'),txHash:hash('x2'),blockNumber:2,
    transactionIndex:0,logIndex:0,account:t.payer,amount:'1001'}]),/mismatch/);pass('unexplained residual cannot become external');
  // Full actual HTTP response validation against OpenAPI, not regex-only.
  const validation=spawnSync('python',['tools/validate_wallet_response.py'],{input:JSON.stringify(schemas),encoding:'utf8'});
  assert.equal(validation.status,0,validation.stderr);console.log(validation.stdout.trim());pass('actual mixed/external HTTP responses satisfy complete schema');
  console.log(JSON.stringify({checks:n,engine:process.env.WEB3_TEST_DATABASE_URL?'PostgreSQL':'PGlite',network:'LOCAL ONLY'}));
}finally{
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}
  await f.close();
}
