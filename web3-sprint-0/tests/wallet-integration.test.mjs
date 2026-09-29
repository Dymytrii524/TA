// Real local EVM -> verified receipts -> PGlite -> HTTP, no external RPC or funds.
import {JsonRpcProvider,ContractFactory,keccak256,toUtf8Bytes} from 'ethers';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {createFixture,freeze,u} from './p1-fixture.mjs';
import {deriveEscrowId,deriveTermsHash} from '../tools/escrow-identity.mjs';
import {reconcileWallet,walletHandler} from '../runtime/wallet.mjs';
const url=process.env.ANVIL_URL??'http://127.0.0.1:8545';
if(!['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname))throw Error('local only');
const rpc=new JsonRpcProvider(url,31337,{staticNetwork:true,cacheTimeout:-1});rpc.pollingInterval=50;
const art=name=>JSON.parse(readFileSync(`out/${name}.sol/${name}.json`));
const hash=s=>keccak256(toUtf8Bytes(s));
const send=async p=>(await p).wait();
const mine=async()=>{await rpc.send('evm_mine',[]);await rpc.send('evm_mine',[])};
let db,server,checks=0;
const pass=s=>{checks++;console.log('PASS F05 EVM/HTTP '+s)};
try{
  const signers=await Promise.all([0,1,2,3,4].map(i=>rpc.getSigner(i)));
  const addr=await Promise.all(signers.map(s=>s.getAddress()));
  const deploy=async(name,args=[])=>{
    const a=art(name),c=await new ContractFactory(a.abi,a.bytecode.object,signers[0]).deploy(...args);
    await c.waitForDeployment();return c;
  };
  const token=await deploy('MockUSDC');
  const escrow=await deploy('TransAtlasEscrow',[await token.getAddress(),...addr.slice(2),10000n*10n**6n,100000n*10n**6n,86400,604800]);
  const contract=(await escrow.getAddress()).toLowerCase();
  const ts=Number((await rpc.send('eth_getBlockByNumber',['latest',false])).timestamp);
  const fixture=await createFixture({contract,token:await token.getAddress(),payer:addr[0],carrier:addr[1],
    arbiter:addr[3],backup:addr[4],nonce:hash('wallet-first'),amount:'1000000000',
    acceptBy:ts+3600,deliveryBy:ts+864000,codeHash:keccak256(await rpc.getCode(contract))});
  db=fixture.db;const t=fixture.t;
  await db.query('INSERT INTO web3.wallet_permissions VALUES($1,$2,true)',[u(4),u(1)]);
  await send(token.mint(addr[0],5000000000n));await send(token.approve(contract,5000000000n));
  const fund=async v=>send(escrow.create(v.nonce,addr[1],v.amount,v.acceptBy,v.deliveryBy,v.agreement,2));
  await fund(t);const earlySettlement=await send(escrow.connect(signers[1]).cancelUnaccepted(t.id));
  await db.query(`INSERT INTO web3.chain_transactions
    (chain_id,tx_hash,state,block_hash,block_number,receipt_success)
    VALUES(31337,$1,'included',$2,$3,true)`,
    [earlySettlement.hash,earlySettlement.blockHash,earlySettlement.blockNumber]);
  const t2={...t,nonce:hash('wallet-second'),amount:'500000000'};
  t2.id=deriveEscrowId(t2.chainId,t2.contract,t2.payer,t2.nonce);t2.termsHash=deriveTermsHash(t2);
  await db.query(`INSERT INTO web3.deals SELECT $1,payer_company_id,carrier_company_id,
    price_amount,price_currency,contract_currency,fx_rate,fx_source,fx_fixed_at,fx_expires_at,
    agreement_commitment,created_at FROM web3.deals WHERE id=$2`,[u(11),u(10)]);
  await freeze(db,t2,u(11));await fund(t2);await send(escrow.connect(signers[1]).cancelUnaccepted(t2.id));
  await mine();
  let snapshot=await reconcileWallet(db,rpc,31337);
  assert.equal(snapshot.ledger.balances[t.payer],'1500000000');pass('two real settlements -> exact claim');
  const count=async()=>Number((await db.query('SELECT count(*) AS n FROM web3.wallet_snapshots_v2')).rows[0].n);
  const before=await count();await reconcileWallet(db,rpc,31337);assert.equal(await count(),before);pass('restart replay no duplicate snapshot');
  const badRpc=override=>({send:async(method,args)=>override(method,args)});
  await assert.rejects(()=>reconcileWallet(db,badRpc((m,args)=>m==='eth_chainId'?'0x89':rpc.send(m,args)),31337),/wrong chain/);
  await assert.rejects(()=>reconcileWallet(db,badRpc((m,args)=>m==='eth_getCode'?'0x00':rpc.send(m,args)),31337),/code mismatch/);
  await assert.rejects(()=>reconcileWallet(db,badRpc((m,args)=>m==='eth_getLogs'?[]:rpc.send(m,args)),31337),/claimable mismatch/);
  await assert.rejects(()=>reconcileWallet(db,badRpc(async(m,args)=>m==='eth_getTransactionReceipt'?
    {...await rpc.send(m,args),status:'0x0'}:rpc.send(m,args)),31337),/failed receipt/);
  assert.equal(await count(),before);pass('wrong chain/code, missing history, failed receipt fail atomically');
  server=createServer(walletHandler({db,rpc,authenticate:async req=>req.headers.authorization==='Bearer fixture-only'?{id:u(4)}:null}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}/api/v1/web3`;
  const request=(path,body,authorized=true)=>fetch(base+path,{method:body?'POST':'GET',
    headers:{...(authorized?{Authorization:'Bearer fixture-only'}:{}),'Content-Type':'application/json','Idempotency-Key':'wallet-http-00001'},
    ...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await request(`/wallets/${u(60)}/claims`,null,false)).status,401);pass('HTTP unauthenticated rejected');
  assert.equal((await request(`/wallets/${u(61)}/claims`)).status,403);pass('HTTP wrong-company wallet rejected');
  const claims=await(await request(`/wallets/${u(60)}/claims`)).json();
  assert.equal(claims.claimable_atomic,'1500000000');pass('HTTP finalized claims');
  const body={action:'withdraw',chain_id:31337};
  const response=await request(`/wallets/${u(60)}/intents`,body);
  assert.equal(response.status,201);const intent=await response.json();
  assert.equal(intent.from,t.payer);assert.equal(intent.to,contract);assert.equal(intent.data,'0x3ccfd60b');
  assert.deepEqual(await(await request(`/wallets/${u(60)}/intents`,body)).json(),intent);pass('HTTP unsigned wallet intent and idempotency');
  assert.equal((await request(`/wallets/${u(60)}/intents`,{...body,deal_id:u(10)})).status,422);pass('HTTP rejects deal-scoped wallet payload');
  // Additional settlement after preparation is included in withdraw-all at execution.
  const t3={...t,nonce:hash('wallet-third'),amount:'100000000'};
  t3.id=deriveEscrowId(t3.chainId,t3.contract,t3.payer,t3.nonce);t3.termsHash=deriveTermsHash(t3);
  await db.query(`INSERT INTO web3.deals SELECT $1,payer_company_id,carrier_company_id,
    price_amount,price_currency,contract_currency,fx_rate,fx_source,fx_fixed_at,fx_expires_at,
    agreement_commitment,created_at FROM web3.deals WHERE id=$2`,[u(12),u(10)]);
  await freeze(db,t3,u(12));await fund(t3);await send(escrow.connect(signers[1]).cancelUnaccepted(t3.id));await mine();
  const saved=await rpc.send('evm_snapshot',[]);
  const receipt=await send(signers[0].sendTransaction({to:intent.to,data:intent.data,value:0}));
  await db.query(`INSERT INTO web3.chain_transactions(chain_id,tx_hash,state)
    VALUES(31337,$1,'submitted')`,[receipt.hash]);
  snapshot=await reconcileWallet(db,rpc,31337);assert.equal(snapshot.ledger.withdrawals.length,0);pass('unfinalized payout not booked');
  await mine();snapshot=await reconcileWallet(db,rpc,31337);
  assert.equal(snapshot.ledger.withdrawals[0].amount_atomic,'1600000000');
  assert.equal(snapshot.ledger.withdrawals[0].allocations.length,3);
  assert.equal(snapshot.ledger.balances[t.payer],'0');pass('actual full sweep after new claim allocated exactly');
  const ev=(await db.query("SELECT escrow_id,event_scope,payload FROM web3.chain_events WHERE event_kind='Withdrawn'")).rows[0];
  assert.equal(ev.escrow_id,null);assert.equal(ev.event_scope,'wallet');pass('actual ABI Withdrawn stored without fake deal ID');
  const paid=await(await request(`/wallets/${u(60)}/claims`)).json();
  assert.equal(paid.withdrawals[0].allocations.length,3);pass('HTTP returns internal allocations not SETTLED=paid');
  await reconcileWallet(db,rpc,31337);
  assert.equal(Number((await db.query("SELECT count(*) n FROM web3.chain_events WHERE event_kind='Withdrawn'")).rows[0].n),1);pass('receipt replay no double effect');
  await db.query('UPDATE web3.wallet_bindings SET revoked_at=now() WHERE id=$1',[u(60)]);
  assert.equal((await request(`/wallets/${u(60)}/intents`,body)).status,403);pass('revoked binding denied including idempotent retry');
  await rpc.send('evm_revert',[saved]);
  await assert.rejects(()=>reconcileWallet(db,rpc,31337),/finality breach/);pass('post-finality reorg halts, preserves audit; no silent rewrite');
  console.log(JSON.stringify({checks,withdrawalTx:receipt.hash,network:'LOCAL ANVIL ONLY'}));
}finally{
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}
  if(db)await db.close();rpc.destroy();
}
