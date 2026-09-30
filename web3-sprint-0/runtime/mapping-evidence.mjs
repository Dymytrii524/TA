import {Interface,keccak256,toQuantity} from 'ethers';
import {readFileSync} from 'node:fs';
const iface=new Interface(JSON.parse(readFileSync(new URL('../artifacts/TransAtlasEscrow.abi.json',import.meta.url))));

// Trusted server pre-create step, NOT a public HTTP endpoint or client assertion.
// Read committed immutable terms BEFORE observing the live chain. Persist the
// canonical block at which getDeal was still absent; never accept a supplied
// timestamp/height/hash. The caller must await commit before returning calldata.
// Trust boundary: synchronized authenticated RPC + privileged evidence writer.
export async function recordMappingPreflight(db,rawRpc,dealId){
  const send=async(...args)=>{
    let timer;
    try{return await Promise.race([rawRpc.send(...args),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(Error('preflight RPC timeout')),15000);
    })])}finally{clearTimeout(timer)}
  };
  return db.transaction(async tx=>{
    const t=(await tx.query('SELECT * FROM web3.deal_terms WHERE deal_id=$1 FOR SHARE',[dealId])).rows[0];
    if(!t)throw Error('missing frozen terms');
    const net=(await tx.query('SELECT * FROM web3.networks WHERE chain_id=$1',[t.chain_id])).rows[0];
    if(!net||![31337,80002].includes(Number(t.chain_id))||
      Number(await send('eth_chainId',[]))!==Number(t.chain_id))throw Error('preflight chain mismatch');
    const old=(await tx.query('SELECT * FROM web3.mapping_preflight WHERE deal_id=$1',[dealId])).rows[0];
    if(old){
      if((await send('eth_getBlockByNumber',[toQuantity(old.block_number),false]))?.hash!==old.block_hash)
        throw Error('preflight anchor orphaned');
      return old;
    }
    const block=await send('eth_getBlockByNumber',['latest',false]);
    if(!block||!Number.isSafeInteger(Number(block.number))||Number(block.number)<Number(net.deployment_block))
      throw Error('preflight block unavailable');
    const tag=toQuantity(block.number);
    if(keccak256(await send('eth_getCode',[net.escrow_address,tag]))!==net.code_hash)
      throw Error('preflight code mismatch');
    const [deal]=iface.decodeFunctionResult('getDeal',await send('eth_call',[
      {to:net.escrow_address,data:iface.encodeFunctionData('getDeal',[t.escrow_id])},tag]));
    if(Number(deal.state)!==0)throw Error('preflight funding already exists');
    if((await send('eth_getBlockByNumber',[tag,false]))?.hash!==block.hash)
      throw Error('preflight anchor changed');
    // Concurrent identical calls may race; the immutable winning observation is
    // sufficient, and is revalidated against the funding block during replay.
    await tx.query(`INSERT INTO web3.mapping_preflight
      (deal_id,chain_id,contract_address,escrow_id,terms_hash,block_number,block_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(deal_id) DO NOTHING`,
      [dealId,t.chain_id,t.escrow_address,t.escrow_id,t.terms_hash,Number(block.number),block.hash]);
    return (await tx.query('SELECT * FROM web3.mapping_preflight WHERE deal_id=$1',[dealId])).rows[0];
  });
}

// Called only on receipt-verified Funded facts. Canonical block ordering, not
// DB/chain wall clocks, establishes the preflight precedes funding.
export async function verifyMappingPreflight(rpc,p,t,f){
  if(!p)return false;
  if(p.deal_id!==t.deal_id||Number(p.chain_id)!==Number(t.chain_id)||
    p.contract_address!==t.escrow_address||p.escrow_id!==f.escrowId||p.terms_hash!==f.termsHash||
    !Number.isSafeInteger(Number(p.block_number))||Number(p.block_number)>=f.blockNumber)
    throw Error('invalid mapping preflight');
  const block=await rpc.send('eth_getBlockByNumber',[toQuantity(p.block_number),false]);
  if(block?.hash!==p.block_hash)throw Error('preflight anchor orphaned');
  const [deal]=iface.decodeFunctionResult('getDeal',await rpc.send('eth_call',[
    {to:p.contract_address,data:iface.encodeFunctionData('getDeal',[p.escrow_id])},toQuantity(p.block_number)]));
  if(Number(deal.state)!==0)throw Error('preflight funding already exists');
  return true;
}
