import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {toQuantity} from 'ethers';

// Bounded pilot ingestion; retries the SAME range. Never skip on RPC error.
export async function readHistory(rpc,address,from,to,topics,{batch=2000,maxBlocks=1000000,maxLogs=100000}={}){
  if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||to<from||to-from+1>maxBlocks||
    !Number.isSafeInteger(batch)||batch<1||batch>10000)throw Error('history range unavailable');
  const all=[];
  for(let start=from;start<=to;start+=batch){
    const end=Math.min(start+batch-1,to);
    let logs;
    for(let attempt=0;;attempt++){
      try{logs=await rpc.send('eth_getLogs',[{address,fromBlock:toQuantity(start),toBlock:toQuantity(end),topics:[topics]}]);break}
      catch(e){if(attempt>=2)throw e}
    }
    if(!Array.isArray(logs)||logs.some(l=>Number(l.blockNumber)<start||Number(l.blockNumber)>end))
      throw Error('incomplete history range');
    all.push(...logs);if(all.length>maxLogs)throw Error('history capacity exceeded');
  }
  return all;
}
export function classify(t,f,previous,approvals,{preflight=false,legacy=false}={}){
  if(!t)return {dealId:null,provenance:'UNATTRIBUTED',payerCompany:null,carrierCompany:null};
  if(t.token_address!==f.token||t.payer_address!==f.payer||t.carrier_address!==f.carrier||
    t.terms_hash!==f.termsHash||BigInt(t.amount_atomic)!==BigInt(f.amount))
    throw Error('TA_MISMATCH');
  // Wall clocks (including rounded seconds) are NOT a causal proof.
  // A published quarantine always requires explicit approval, even if evidence
  // is subsequently discovered. Published TA attribution survives exact replay.
  const continued=previous?.provenance==='TA_MATCHED'&&previous.dealId===t.deal_id&&
    previous.funding_event===`${f.blockHash}:${f.txHash}:${f.logIndex}`;
  const proved=previous?.provenance!=='UNATTRIBUTED'&&(preflight||legacy||continued);
  if(!proved&&!approvals.some(a=>a.escrow_id===f.escrowId&&a.deal_id===t.deal_id))
    return {dealId:null,provenance:'UNATTRIBUTED',payerCompany:null,carrierCompany:null};
  return {dealId:t.deal_id,provenance:'TA_MATCHED',
    payerCompany:t.commercial_snapshot.payer_company_id,carrierCompany:t.commercial_snapshot.carrier_company_id};
}
export function legacyLedger(ledger){
  return {policy_version:'F05-B/1',
    lots:ledger.lots.map(({provenance,company_id,...l})=>l),
    withdrawals:ledger.withdrawals.map(w=>({...w,allocations:w.allocations.map(({provenance,company_id,...a})=>a)})),
    balances:ledger.balances};
}
export async function publishSnapshot(tx,net,anchor,ledger,previous){
  const classification='0x'+createHash('sha256').update(JSON.stringify(ledger.classifications)).digest('hex');
  const revision=previous?Number(previous.projection_revision)+(previous.classification_hash===classification?0:1):1;
  const old=(await tx.query(`SELECT * FROM web3.wallet_snapshots_v2
    WHERE chain_id=$1 AND contract_address=$2 AND block_hash=$3 AND projection_revision=$4`,
    [net.chain_id,net.escrow_address,anchor.hash,revision])).rows[0];
  let id=old?.id;
  if(old){
    if(!isDeepStrictEqual(old.subledger,ledger))throw Error('conflicting finalized snapshot');
  }else{
    id=randomUUID();
    await tx.query(`INSERT INTO web3.wallet_snapshots_v2
      (id,chain_id,contract_address,token_address,block_number,block_hash,policy_version,projection_revision,classification_hash,subledger)
      VALUES($1,$2,$3,$4,$5,$6,'F05-B/2',$7,$8,$9::jsonb)`,
      [id,net.chain_id,net.escrow_address,net.token_address,Number(anchor.number),anchor.hash,revision,classification,JSON.stringify(ledger)]);
  }
  await tx.query(`INSERT INTO web3.wallet_active_snapshot VALUES($1,$2,$3)
    ON CONFLICT(chain_id,contract_address) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id`,
    [net.chain_id,net.escrow_address,id]);
  return revision;
}

// Return only the authorized company's TA references. Wallet totals remain
// complete; another company's attribution is redacted, never claimed as its own.
export function publicWallet(snapshot,binding){
  const account=binding.wallet_address;
  const visible=l=>l.company_id===binding.company_id;
  const clean=l=>{
    const {company_id,...r}=l;
    if(r.deal_id&&!visible(l)){r.deal_id=null;r.provenance='RESTRICTED'}
    return r;
  };
  const total=snapshot.ledger.balances[account]??'0';
  const ta=snapshot.ledger.lots.filter(l=>l.account===account&&!l.withdrawal_event&&visible(l))
    .reduce((s,l)=>s+BigInt(l.amount_atomic),0n);
  const unattributed=snapshot.ledger.unattributed_balances[account]??'0';
  const restricted=BigInt(total)-ta-BigInt(unattributed);
  return {chain_id:snapshot.chain_id,contract:snapshot.contract,token:snapshot.token,
    account,block_number:snapshot.block_number,block_hash:snapshot.block_hash,
    claimable_atomic:total,ta_claimable_atomic:String(ta),unattributed_claimable_atomic:unattributed,
    restricted_claimable_atomic:String(restricted),reconciliation_status:'VERIFIED',
    policy_version:'F05-B/2',projection_revision:snapshot.projection_revision,
    warnings:[...(BigInt(unattributed)>0n?['WITHDRAW_ALL_INCLUDES_UNATTRIBUTED']:[]),
      ...(restricted>0n?['WITHDRAW_ALL_INCLUDES_RESTRICTED']:[])],
    lots:snapshot.ledger.lots.filter(l=>l.account===account).map(clean),
    withdrawals:snapshot.ledger.withdrawals.filter(w=>w.account===account)
      .map(w=>({...w,allocations:w.allocations.map(clean)}))};
}
