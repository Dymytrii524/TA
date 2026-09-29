// F05-B executable service, no keys/signing/broadcast. Caller supplies a DB adapter
// with transaction(fn), and trusted authentication; HTTP never accepts a user ID.
import {Interface,keccak256,toQuantity} from 'ethers';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {persistVerifiedTransaction,persistVerifiedEvent} from './finality.mjs';
import {readHistory,classify,legacyLedger,publishSnapshot,publicWallet} from './subsets.mjs';
import {DomainError,ReconciliationError,safeReason} from './errors.mjs';
export const iface=new Interface(JSON.parse(readFileSync(new URL('../artifacts/TransAtlasEscrow.abi.json',import.meta.url))));
const fail=(code,status=409)=>{throw new DomainError(code,status)};
const atomic=x=>{
  if(typeof x!=='string'||!/^(0|[1-9][0-9]*)$/.test(x)||BigInt(x)>=2n**256n) fail('invalid atomic');
  return BigInt(x);
};
const lower=x=>x.toLowerCase();
const key=e=>`${e.blockHash}:${e.txHash}:${e.logIndex}`;
const position=e=>[e.blockNumber,e.transactionIndex,e.logIndex];
const cmp=(a,b)=>{for(let i=0;i<3;i++){const d=position(a)[i]-position(b)[i];if(d)return d}return 0};

// Pure deterministic subledger: input must be a COMPLETE verified canonical
// stream for ONE chain/contract/token. All allocation quantities remain exact.
export function replayWallet(events){
  const lots=[],withdrawals=[],seen=new Map(),settled=new Set(),positions=new Set();
  for(const e of [...events].sort(cmp)){
    if(seen.has(key(e))){
      if(JSON.stringify(seen.get(key(e)))!==JSON.stringify(e)) fail('conflicting replay');
      continue;
    }
    if(position(e).some(v=>!Number.isSafeInteger(v)||v<0)) fail('invalid event position');
    const pos=position(e).join(':');
    if(positions.has(pos))fail('conflicting canonical position');
    positions.add(pos);seen.set(key(e),e);
    if(e.kind==='Settled'){
      if(settled.has(e.escrowId))fail('duplicate settlement');
      settled.add(e.escrowId);
      if(atomic(e.payerAmount)+atomic(e.carrierAmount)!==atomic(e.amount))fail('settlement mismatch');
      for(const [account,amount,kind] of [[e.payer,e.payerAmount,'refund'],[e.carrier,e.carrierAmount,'proceeds']]){
        if(atomic(amount)>0n)lots.push({id:`${key(e)}:${kind}`,deal_id:e.dealId??null,escrow_id:e.escrowId,
          provenance:e.dealId?'TA_MATCHED':'UNATTRIBUTED',company_id:kind==='refund'?e.payerCompany??null:e.carrierCompany??null,
          account,amount_atomic:amount,kind,settlement_event:key(e),withdrawal_event:null});
      }
    }else if(e.kind==='Withdrawn'){
      const pending=lots.filter(l=>l.account===e.account&&l.withdrawal_event===null);
      if(atomic(e.amount)===0n||pending.reduce((n,l)=>n+atomic(l.amount_atomic),0n)!==atomic(e.amount))
        fail('withdrawal reconciliation mismatch');
      const allocations=pending.map(l=>({lot_id:l.id,deal_id:l.deal_id,amount_atomic:l.amount_atomic,
        provenance:l.provenance,company_id:l.company_id}));
      pending.forEach(l=>l.withdrawal_event=key(e));
      withdrawals.push({event:key(e),account:e.account,amount_atomic:e.amount,allocations});
    }else fail('unsupported wallet event');
  }
  const balances={},ta_balances={},unattributed_balances={};
  for(const l of lots){
    const amount=l.withdrawal_event?0n:atomic(l.amount_atomic);
    balances[l.account]=String(BigInt(balances[l.account]??0)+amount);
    const part=l.provenance==='TA_MATCHED'?ta_balances:unattributed_balances;
    part[l.account]=String(BigInt(part[l.account]??0)+amount);
  }
  return {policy_version:'F05-B/2',lots,withdrawals,balances,ta_balances,unattributed_balances};
}

// Reads FULL history on each sync (bounded pilot implementation, not a scalable
// production indexer). Verifies receipts, code, chain, finality anchor, frozen
// parties, settlement totals and claimable at the SAME block.
export async function reconcileWallet(db,rpc,chainId,{localConfirmations=2}={}){
  const fail=reason=>{throw new ReconciliationError(reason)};
  // Bound individual RPC calls; do not accept stale partial results on timeout.
  const rawRpc=rpc;
  rpc={send:async(...args)=>{
    let timer;
    try{return await Promise.race([rawRpc.send(...args),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(Error('RPC timeout')),15000);
    })])}finally{clearTimeout(timer)}
  }};
  return db.transaction(async tx=>{
    const net=(await tx.query('SELECT * FROM web3.networks WHERE chain_id=$1 FOR UPDATE',[chainId])).rows[0];
    if(!net)fail('unknown network');
    if(Number(await rpc.send('eth_chainId',[]))!==chainId)fail('wrong chain');
    let anchor;
    if(chainId===31337){
      if(!Number.isSafeInteger(localConfirmations)||localConfirmations<2)fail('local finality policy');
      const head=Number(await rpc.send('eth_blockNumber',[]));
      if(head<localConfirmations)fail('no final block');
      anchor=await rpc.send('eth_getBlockByNumber',[toQuantity(head-localConfirmations),false]);
    }else if(chainId===80002){
      anchor=await rpc.send('eth_getBlockByNumber',['finalized',false]);
    }else fail('unsupported chain');
    if(!anchor)fail('finality unavailable');
    const height=Number(anchor.number),tag=toQuantity(height);
    if(height<Number(net.deployment_block))fail('before deployment');
    const call=async(name,args=[])=>iface.decodeFunctionResult(name,await rpc.send('eth_call',[
      {to:net.escrow_address,data:iface.encodeFunctionData(name,args)},tag]));
    if(keccak256(await rpc.send('eth_getCode',[net.escrow_address,tag]))!==net.code_hash)fail('code mismatch');
    if(lower((await call('token'))[0])!==net.token_address)fail('token mismatch');
    const previous=(await tx.query(`SELECT s.* FROM web3.wallet_active_snapshot a
      JOIN web3.wallet_snapshots_v2 s ON s.id=a.snapshot_id
      WHERE a.chain_id=$1 AND a.contract_address=$2`,[chainId,net.escrow_address])).rows[0];
    if(previous){
      const block=await rpc.send('eth_getBlockByNumber',[toQuantity(previous.block_number),false]);
      if(!block||block.hash!==previous.block_hash||height<Number(previous.block_number))
        fail('finality breach: halt reconciliation');
    }
    const terms=(await tx.query('SELECT * FROM web3.deal_terms WHERE chain_id=$1 AND escrow_address=$2',[chainId,net.escrow_address])).rows;
    const approvals=(await tx.query('SELECT * FROM web3.wallet_mapping_approvals WHERE chain_id=$1 AND contract_address=$2',[chainId,net.escrow_address])).rows;
    const logs=await readHistory(rpc,net.escrow_address,Number(net.deployment_block),height,
      ['Funded','Settled','Withdrawn'].map(n=>iface.getEvent(n).topicHash));
    logs.sort((a,b)=>Number(a.blockNumber)-Number(b.blockNumber)||Number(a.transactionIndex)-Number(b.transactionIndex)||Number(a.logIndex)-Number(b.logIndex));
    const receipts=new Map(),blocks=new Map(),events=[],funding=new Map(),allEvents=[],seen=new Map(),positions=new Set();
    for(const log of logs){
      let receipt=receipts.get(log.transactionHash);
      if(!receipt){
        receipt=await rpc.send('eth_getTransactionReceipt',[log.transactionHash]);
        if(!receipt||receipt.transactionHash!==log.transactionHash||Number(receipt.status)!==1)fail('failed receipt');
        const block=await rpc.send('eth_getBlockByNumber',[receipt.blockNumber,false]);
        if(!block||block.hash!==receipt.blockHash)fail('orphaned receipt');
        receipts.set(log.transactionHash,receipt);
      }
      if(lower(log.address)!==net.escrow_address||log.removed||receipt.blockHash!==log.blockHash||Number(log.blockNumber)>height
        ||Number(receipt.blockNumber)!==Number(log.blockNumber)
        ||Number(receipt.transactionIndex)!==Number(log.transactionIndex)
        ||!receipt.logs.some(l=>l.logIndex===log.logIndex&&lower(l.address)===net.escrow_address
          &&l.data===log.data&&JSON.stringify(l.topics)===JSON.stringify(log.topics)))fail('unverified log');
      const p=iface.parseLog(log),e={kind:p.name,blockHash:log.blockHash,txHash:log.transactionHash,
        blockNumber:Number(log.blockNumber),transactionIndex:Number(log.transactionIndex),logIndex:Number(log.logIndex)};
      const k=key(e),proof=JSON.stringify({address:log.address,data:log.data,topics:log.topics,position:position(e)});
      if(seen.has(k)){if(seen.get(k)!==proof)fail('conflicting replay');continue}
      seen.set(k,proof);
      if(position(e).some(v=>!Number.isSafeInteger(v)||v<0)||positions.has(position(e).join(':')))
        fail('conflicting canonical position');
      positions.add(position(e).join(':'));
      if(p.name==='Funded'){
        if(funding.has(p.args.id))fail('duplicate funding');
        const [d]=await call('getDeal',[p.args.id]);
        if(lower(d.payer)!==lower(p.args.payer)||lower(d.carrier)!==lower(p.args.carrier)||
          d.termsHash!==p.args.termsHash||d.amount!==p.args.amount||Number(d.state)===0)fail('funding proof mismatch');
        if(!blocks.has(e.blockHash))blocks.set(e.blockHash,await rpc.send('eth_getBlockByNumber',[toQuantity(e.blockNumber),false]));
        Object.assign(e,{escrowId:p.args.id,payer:lower(d.payer),carrier:lower(d.carrier),
          amount:String(d.amount),termsHash:d.termsHash,token:net.token_address,
          timestamp:Number(blocks.get(e.blockHash).timestamp),settled:Number(d.state)===6});
        const t=terms.find(t=>t.escrow_id===e.escrowId);
        Object.assign(e,classify(t,e,previous?.subledger.classifications.find(c=>c.escrowId===e.escrowId),approvals));
        funding.set(e.escrowId,e);
      }else if(p.name==='Settled'){
        const f=funding.get(p.args.id);
        if(!f||!f.settled)fail('missing verified funding');
        Object.assign(e,{escrowId:f.escrowId,dealId:f.dealId,payer:f.payer,carrier:f.carrier,
          payerCompany:f.payerCompany,carrierCompany:f.carrierCompany,
          amount:f.amount,payerAmount:String(p.args.payerAmount),carrierAmount:String(p.args.carrierAmount)});
        events.push(e);
      }else{
        Object.assign(e,{account:lower(p.args.account),amount:String(p.args.amount)});events.push(e);
      }
      allEvents.push(e);
    }
    const ledger=replayWallet(events);
    ledger.classifications=[...funding.values()].map(f=>({escrowId:f.escrowId,dealId:f.dealId,provenance:f.provenance,
      reason:f.dealId?'VERIFIED_TA_TERMS':'NO_VERIFIED_TA_MAPPING',funding_event:key(f)})).sort((a,b)=>a.escrowId.localeCompare(b.escrowId));
    const settledIds=new Set(events.filter(e=>e.kind==='Settled').map(e=>e.escrowId));
    if([...funding.values()].some(f=>f.settled!==settledIds.has(f.escrowId)))fail('missing settlement history');
    // Include all frozen counterparties, even if a missing Settled log would
    // otherwise conceal their entire positive balance.
    const accounts=new Set([...Object.keys(ledger.balances),...terms.flatMap(t=>[t.payer_address,t.carrier_address]),
      ...[...funding.values()].flatMap(f=>[f.payer,f.carrier])]);
    for(const account of accounts){
      if(String((await call('claimable',[account]))[0])!==(ledger.balances[account]??'0'))fail('claimable mismatch');
    }
    if(String((await call('totalClaimable'))[0])!==String(Object.values(ledger.balances).reduce((n,a)=>n+BigInt(a),0n))
      ||String((await call('totalWithdrawn'))[0])!==String(ledger.withdrawals.reduce((n,w)=>n+BigInt(w.amount_atomic),0n)))
      fail('global liability mismatch');
    const deposited=[...funding.values()].reduce((n,f)=>n+BigInt(f.amount),0n);
    const locked=[...funding.values()].filter(f=>!f.settled).reduce((n,f)=>n+BigInt(f.amount),0n);
    if(String((await call('totalDeposited'))[0])!==String(deposited)||
      String((await call('locked'))[0])!==String(locked))fail('deposit history mismatch');
    const erc20=new Interface(['function balanceOf(address) view returns (uint256)']);
    const tokenBalance=erc20.decodeFunctionResult('balanceOf',await rpc.send('eth_call',[
      {to:net.token_address,data:erc20.encodeFunctionData('balanceOf',[net.escrow_address])},tag]))[0];
    if(tokenBalance<locked+Object.values(ledger.balances).reduce((n,v)=>n+BigInt(v),0n))fail('insolvent contract');
    const end=await rpc.send('eth_getBlockByNumber',[tag,false]);
    if(!end||end.hash!==anchor.hash)fail('anchor changed during reconciliation');
    // First V2 activation must replay and verify ALL historical V1 snapshots.
    if(!previous){
      const legacy=(await tx.query('SELECT * FROM web3.wallet_reconciliations WHERE chain_id=$1 AND contract_address=$2',[chainId,net.escrow_address])).rows;
      for(const s of legacy){
        const b=await rpc.send('eth_getBlockByNumber',[toQuantity(s.block_number),false]);
        if(!b||b.hash!==s.block_hash||Number(s.block_number)>height)fail('legacy finality conflict');
        if(!isDeepStrictEqual(s.subledger,legacyLedger(replayWallet(events.filter(e=>e.blockNumber<=Number(s.block_number))))))
          fail('legacy backfill mismatch');
      }
    }
    for(const e of allEvents){
      await persistVerifiedTransaction(tx,rpc,chainId,e);
      await persistVerifiedEvent(tx,chainId,net.escrow_address,e);
    }
    if((await rpc.send('eth_getBlockByNumber',[tag,false]))?.hash!==anchor.hash)
      fail('anchor changed before publish');
    const projection_revision=await publishSnapshot(tx,net,anchor,ledger,previous);
    return {chain_id:chainId,contract:net.escrow_address,token:net.token_address,
      block_number:height,block_hash:anchor.hash,projection_revision,ledger};
  });
}

export async function authorizeWallet(db,userId,bindingId,lock=false){
  const b=(await db.query(`SELECT b.*,n.escrow_address,n.token_address FROM web3.wallet_bindings b
    JOIN web3.wallet_permissions p ON p.company_id=b.company_id
    JOIN web3.networks n ON n.chain_id=b.chain_id
    WHERE b.id=$1 AND p.user_id=$2 AND p.can_withdraw AND b.revoked_at IS NULL
    ${lock?'FOR SHARE OF b,p':''}`,[bindingId,userId])).rows[0];
  if(!b)fail('wallet authorization denied',403);
  return b;
}
export async function prepareWithdrawal(db,userId,bindingId,idempotencyKey,body,snapshot){
  if(typeof idempotencyKey!=='string'||idempotencyKey.length<16||idempotencyKey.length>128)fail('invalid idempotency key',422);
  if(!body||Object.keys(body).sort().join(',')!=='action,chain_id'||body.action!=='withdraw')fail('invalid wallet request',422);
  const requestHash='0x'+createHash('sha256').update(JSON.stringify({action:body.action,chain_id:body.chain_id})).digest('hex');
  return db.transaction(async tx=>{
    // Serialize first, then read AND lock the current permission/binding.
    // This covers revocation while waiting for the lock, including retries.
    await tx.query('SELECT id FROM web3.wallet_bindings WHERE id=$1 FOR UPDATE',[bindingId]);
    const b=await authorizeWallet(tx,userId,bindingId,true);
    if(body.chain_id!==Number(b.chain_id)||snapshot.chain_id!==body.chain_id
      ||snapshot.contract!==b.escrow_address||snapshot.token!==b.token_address)fail('wallet scope mismatch',422);
    const existing=(await tx.query(`SELECT * FROM web3.intents WHERE actor_user_id=$1 AND wallet_binding_id=$2
      AND action='withdraw' AND idempotency_key=$3`,[userId,bindingId,idempotencyKey])).rows[0];
    let intent=existing;
    if(existing){
      if(existing.request_hash!==requestHash)fail('idempotency conflict');
      if(new Date(existing.expires_at)<=new Date()||existing.status!=='prepared')fail('intent no longer usable');
    }else{
      if(BigInt(snapshot.ledger.balances[b.wallet_address]??0)===0n)fail('no finalized claim');
      intent=(await tx.query(`INSERT INTO web3.intents
        (id,deal_id,actor_user_id,chain_id,action,idempotency_key,request_hash,status,created_at,expires_at,wallet_binding_id)
        VALUES($1,NULL,$2,$3,'withdraw',$4,$5,'prepared',now(),now()+interval '5 minutes',$6) RETURNING *`,
        [randomUUID(),userId,b.chain_id,idempotencyKey,requestHash,bindingId])).rows[0];
    }
    return {intent_id:intent.id,chain_id:Number(b.chain_id),from:b.wallet_address,to:b.escrow_address,
      data:iface.encodeFunctionData('withdraw'),value_atomic:'0',expires_at:new Date(intent.expires_at).toISOString(),broadcast:false};
  });
}

// Mount this handler in TA behind a trusted authenticate(req) adapter. Missing
// adapter denies ALL requests; no built-in dev bearer token or unsigned JWT.
export function walletHandler({db,rpc,authenticate=async()=>null,
  audit=entry=>console.error(JSON.stringify(entry))}){
  return async(req,res)=>{
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':status>=400?'application/problem+json':'application/json'});res.end(JSON.stringify(data))};
    try{
      const user=await authenticate(req);
      if(!user?.id)fail('unauthenticated',401);
      const match=new URL(req.url,'http://localhost').pathname.match(/^\/api\/v1\/web3\/wallets\/([0-9a-f-]{36})\/(claims|intents)$/);
      if(!match)fail('not found',404);
      const binding=await authorizeWallet(db,user.id,match[1]);
      if((match[2]==='claims'&&req.method!=='GET')||(match[2]==='intents'&&req.method!=='POST'))fail('method not allowed',405);
      let body;
      if(req.method==='POST'){
        let text='',bytes=0;for await(const chunk of req){bytes+=Buffer.byteLength(chunk);if(bytes>4096)fail('body too large',413);text+=chunk}
        try{body=JSON.parse(text)}catch{fail('invalid JSON',422)}
      }
      let snapshot;
      try{snapshot=await reconcileWallet(db,rpc,Number(binding.chain_id))}
      catch(e){throw new ReconciliationError(safeReason(e))}
      if(match[2]==='claims'){
        await authorizeWallet(db,user.id,match[1]); // revocation during reconciliation
        send(200,publicWallet(snapshot,binding));
      }else send(201,await prepareWithdrawal(db,user.id,match[1],req.headers['idempotency-key'],body,snapshot));
    }catch(e){
      if(e instanceof DomainError){
        send(e.status,{type:'about:blank',title:e.message,status:e.status,code:e.message});
      }else{
        const correlation_id=randomUUID();
        const reason=safeReason(e);
        try{audit({event:'web3.reconciliation_failed',correlation_id,
          reason})}catch{/* logger cannot change response */}
        send(503,{type:'about:blank',title:'Reconciliation unavailable',status:503,
          code:'RECONCILIATION_UNAVAILABLE',correlation_id});
      }
    }
  };
}
