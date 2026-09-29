import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {toQuantity} from 'ethers';

// Called only inside the reconciliation transaction, AFTER receipt/log/code/
// chain/finality/anchor validation. Does not confirm an API intent association.
export async function persistVerifiedTransaction(tx,rpc,chainId,e){
  await tx.query(`INSERT INTO web3.chain_transactions
    (chain_id,tx_hash,state,block_hash,block_number,receipt_success)
    VALUES($1,$2,'finalized',$3,$4,true) ON CONFLICT(chain_id,tx_hash) DO NOTHING`,
    [chainId,e.txHash,e.blockHash,e.blockNumber]);
  const old=(await tx.query(`SELECT * FROM web3.chain_transactions
    WHERE chain_id=$1 AND tx_hash=$2 FOR UPDATE`,[chainId,e.txHash])).rows[0];
  const same=old.block_hash===e.blockHash&&Number(old.block_number)===e.blockNumber&&old.receipt_success===true;
  if(old.state==='finalized'){
    if(!same)throw Error('transaction history conflict');
    return; // Never UPDATE finalized rows, even identically.
  }
  // An old inclusion can change only after evidence it is no longer canonical.
  if(old.block_hash&&!same){
    const b=await rpc.send('eth_getBlockByNumber',[toQuantity(old.block_number),false]);
    if(!b||b.hash===old.block_hash)throw Error('unproven pre-finality reorg');
  }else if(['failed','orphaned'].includes(old.state)&&!old.block_hash){
    throw Error('missing prior inclusion proof');
  }
  await tx.query(`INSERT INTO web3.transaction_observations(id,chain_id,tx_hash,previous,verified)
    VALUES($1,$2,$3,$4::jsonb,$5::jsonb)`,
    [randomUUID(),chainId,e.txHash,JSON.stringify(old),JSON.stringify(e)]);
  await tx.query(`UPDATE web3.chain_transactions SET state='finalized',
    block_hash=$3,block_number=$4,receipt_success=true WHERE chain_id=$1 AND tx_hash=$2`,
    [chainId,e.txHash,e.blockHash,e.blockNumber]);
}

export async function persistVerifiedEvent(tx,chainId,contract,e){
  const payload=e.kind==='Funded'?{payer:e.payer,carrier:e.carrier,amount:e.amount,termsHash:e.termsHash}:
    e.kind==='Withdrawn'?{account:e.account,amount:e.amount}:
    {payerAmount:e.payerAmount,carrierAmount:e.carrierAmount,transactionIndex:e.transactionIndex};
  await tx.query(`INSERT INTO web3.chain_events
    (id,chain_id,tx_hash,block_hash,log_index,contract_address,escrow_id,event_kind,payload,finalized)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,true)
    ON CONFLICT(chain_id,block_hash,tx_hash,log_index) DO NOTHING`,
    [randomUUID(),chainId,e.txHash,e.blockHash,e.logIndex,contract,e.escrowId??null,e.kind,JSON.stringify(payload)]);
  const old=(await tx.query(`SELECT * FROM web3.chain_events
    WHERE chain_id=$1 AND block_hash=$2 AND tx_hash=$3 AND log_index=$4 FOR UPDATE`,
    [chainId,e.blockHash,e.txHash,e.logIndex])).rows[0];
  if(old.contract_address!==contract||old.event_kind!==e.kind||
    old.escrow_id!==(e.escrowId??null)||!isDeepStrictEqual(old.payload,payload))
    throw Error('event history conflict');
  if(!old.finalized)await tx.query('UPDATE web3.chain_events SET finalized=true WHERE id=$1',[old.id]);
}
