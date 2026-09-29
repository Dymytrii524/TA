// F05-B executable service, no keys/signing/broadcast. Caller supplies a DB adapter
// with transaction(fn), and trusted authentication; HTTP never accepts a user ID.
import {Interface,keccak256,toQuantity} from 'ethers';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {persistVerifiedTransaction,persistVerifiedEvent} from './finality.mjs';
export const iface=new Interface(JSON.parse(readFileSync(new URL('../artifacts/TransAtlasEscrow.abi.json',import.meta.url))));
const fail=(code,status=409)=>{throw Object.assign(new Error(code),{status})};
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
        if(atomic(amount)>0n)lots.push({id:`${key(e)}:${kind}`,deal_id:e.dealId,escrow_id:e.escrowId,
          account,amount_atomic:amount,kind,settlement_event:key(e),withdrawal_event:null});
      }
    }else if(e.kind==='Withdrawn'){
      const pending=lots.filter(l=>l.account===e.account&&l.withdrawal_event===null);
      if(atomic(e.amount)===0n||pending.reduce((n,l)=>n+atomic(l.amount_atomic),0n)!==atomic(e.amount))
        fail('withdrawal reconciliation mismatch');
      const allocations=pending.map(l=>({lot_id:l.id,deal_id:l.deal_id,amount_atomic:l.amount_atomic}));
      pending.forEach(l=>l.withdrawal_event=key(e));
      withdrawals.push({event:key(e),account:e.account,amount_atomic:e.amount,allocations});
    }else fail('unsupported wallet event');
  }
  const balances={};
  for(const l of lots)balances[l.account]=String(BigInt(balances[l.account]??0)+(l.withdrawal_event?0n:atomic(l.amount_atomic)));
  return {policy_version:'F05-B/1',lots,withdrawals,balances};
}

// Reads FULL history on each sync (bounded pilot implementation, not a scalable
// production indexer). Verifies receipts, code, chain, finality anchor, frozen
// parties, settlement totals and claimable at the SAME block.
export async function reconcileWallet(db,rpc,chainId,{localConfirmations=2}={}){
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
    const previous=(await tx.query(`SELECT * FROM web3.wallet_reconciliations
      WHERE chain_id=$1 AND contract_address=$2 ORDER BY block_number DESC LIMIT 1`,[chainId,net.escrow_address])).rows[0];
    if(previous){
      const block=await rpc.send('eth_getBlockByNumber',[toQuantity(previous.block_number),false]);
      if(!block||block.hash!==previous.block_hash||height<Number(previous.block_number))
        fail('finality breach: halt reconciliation');
    }
    const terms=(await tx.query('SELECT * FROM web3.deal_terms WHERE chain_id=$1',[chainId])).rows;
    const logs=await rpc.send('eth_getLogs',[{address:net.escrow_address,
      fromBlock:toQuantity(net.deployment_block),toBlock:tag,
      topics:[[iface.getEvent('Settled').topicHash,iface.getEvent('Withdrawn').topicHash]]}]);
    const receipts=new Map(),events=[];
    for(const log of logs){
      let receipt=receipts.get(log.transactionHash);
      if(!receipt){
        receipt=await rpc.send('eth_getTransactionReceipt',[log.transactionHash]);
        if(!receipt||Number(receipt.status)!==1)fail('failed receipt');
        const block=await rpc.send('eth_getBlockByNumber',[receipt.blockNumber,false]);
        if(!block||block.hash!==receipt.blockHash)fail('orphaned receipt');
        receipts.set(log.transactionHash,receipt);
      }
      if(log.removed||receipt.blockHash!==log.blockHash||Number(log.blockNumber)>height
        ||Number(receipt.blockNumber)!==Number(log.blockNumber)
        ||Number(receipt.transactionIndex)!==Number(log.transactionIndex)
        ||!receipt.logs.some(l=>l.logIndex===log.logIndex&&lower(l.address)===net.escrow_address
          &&l.data===log.data&&JSON.stringify(l.topics)===JSON.stringify(log.topics)))fail('unverified log');
      const p=iface.parseLog(log),e={kind:p.name,blockHash:log.blockHash,txHash:log.transactionHash,
        blockNumber:Number(log.blockNumber),transactionIndex:Number(log.transactionIndex),logIndex:Number(log.logIndex)};
      if(p.name==='Settled'){
        const t=terms.find(t=>t.escrow_id===p.args.id&&t.escrow_address===net.escrow_address);
        if(!t)fail('missing frozen deal history');
        const [d]=await call('getDeal',[p.args.id]);
        if(lower(d.payer)!==t.payer_address||lower(d.carrier)!==t.carrier_address
          ||d.termsHash!==t.terms_hash||d.amount!==BigInt(t.amount_atomic)||Number(d.state)!==6)fail('frozen settlement mismatch');
        Object.assign(e,{escrowId:p.args.id,dealId:t.deal_id,payer:t.payer_address,carrier:t.carrier_address,
          amount:String(t.amount_atomic),payerAmount:String(p.args.payerAmount),carrierAmount:String(p.args.carrierAmount)});
      }else Object.assign(e,{account:lower(p.args.account),amount:String(p.args.amount)});
      events.push(e);
    }
    const ledger=replayWallet(events);
    // Include all frozen counterparties, even if a missing Settled log would
    // otherwise conceal their entire positive balance.
    const accounts=new Set([...Object.keys(ledger.balances),...terms.flatMap(t=>[t.payer_address,t.carrier_address])]);
    for(const account of accounts){
      if(String((await call('claimable',[account]))[0])!==(ledger.balances[account]??'0'))fail('claimable mismatch');
    }
    if(String((await call('totalClaimable'))[0])!==String(Object.values(ledger.balances).reduce((n,a)=>n+BigInt(a),0n))
      ||String((await call('totalWithdrawn'))[0])!==String(ledger.withdrawals.reduce((n,w)=>n+BigInt(w.amount_atomic),0n)))
      fail('global liability mismatch');
    const end=await rpc.send('eth_getBlockByNumber',[tag,false]);
    if(!end||end.hash!==anchor.hash)fail('anchor changed during reconciliation');
    const old=(await tx.query('SELECT subledger FROM web3.wallet_reconciliations WHERE chain_id=$1 AND contract_address=$2 AND block_hash=$3',
      [chainId,net.escrow_address,anchor.hash])).rows[0];
    if(old){
      // JSONB object ordering is immaterial; compare canonical contents.
      if(!isDeepStrictEqual(old.subledger,ledger))fail('conflicting finalized snapshot');
    }else await tx.query(`INSERT INTO web3.wallet_reconciliations
      (id,chain_id,contract_address,token_address,block_number,block_hash,policy_version,subledger)
      VALUES($1,$2,$3,$4,$5,$6,'F05-B/1',$7::jsonb)`,
      [randomUUID(),chainId,net.escrow_address,net.token_address,height,anchor.hash,JSON.stringify(ledger)]);
    for(const e of events){
      await persistVerifiedTransaction(tx,rpc,chainId,e);
      await persistVerifiedEvent(tx,chainId,net.escrow_address,e);
    }
    return {chain_id:chainId,contract:net.escrow_address,token:net.token_address,
      block_number:height,block_hash:anchor.hash,ledger};
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
export function walletHandler({db,rpc,authenticate=async()=>null}){
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
        let text='';for await(const chunk of req){text+=chunk;if(text.length>4096)fail('body too large',413)}
        try{body=JSON.parse(text)}catch{fail('invalid JSON',422)}
      }
      const snapshot=await reconcileWallet(db,rpc,Number(binding.chain_id));
      if(match[2]==='claims'){
        await authorizeWallet(db,user.id,match[1]); // revocation during reconciliation
        send(200,{chain_id:snapshot.chain_id,contract:snapshot.contract,token:snapshot.token,
          account:binding.wallet_address,block_number:snapshot.block_number,block_hash:snapshot.block_hash,
          claimable_atomic:snapshot.ledger.balances[binding.wallet_address]??'0',
          lots:snapshot.ledger.lots.filter(l=>l.account===binding.wallet_address),
          withdrawals:snapshot.ledger.withdrawals.filter(w=>w.account===binding.wallet_address)});
      }else send(201,await prepareWithdrawal(db,user.id,match[1],req.headers['idempotency-key'],body,snapshot));
    }catch(e){send(e.status??503,{type:'about:blank',title:e.status?e.message:'reconciliation unavailable',status:e.status??503,code:e.status?e.message:'RECONCILIATION_UNAVAILABLE'})}
  };
}
