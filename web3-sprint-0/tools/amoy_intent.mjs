// Offline unsigned constructor calldata only. Never connects or broadcasts.
import {ContractFactory, isAddress, getAddress} from 'ethers';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

export function validateConfig(c){
  if(c.chain_id!==80002 || c.broadcast_enabled!==false)
    throw new Error('Only Amoy with broadcast disabled');
  if(c.token_address?.toLowerCase()!=='0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582' || c.token_decimals!==6)
    throw new Error('Wrong test USDC');
  const roles=['guardian','arbiter','backup_arbiter'].map(k=>{
    if(!isAddress(c[k]) || /^0x0{40}$/i.test(c[k])) throw new Error(`Set valid ${k}`);
    return getAddress(c[k]);
  });
  if(new Set(roles).size!==3) throw new Error('Roles must be distinct');
  const atomic=k=>{
    if(!/^[1-9][0-9]*$/.test(c[k])) throw new Error(`Invalid ${k}`);
    const n=BigInt(c[k]); if(n>=2n**256n) throw new Error('uint256 overflow'); return n;
  };
  const per=atomic('max_per_deal_atomic'),total=atomic('max_liability_atomic');
  if(total<per) throw new Error('Liability cap below per-deal cap');
  const cp=c.challenge_period_seconds,ap=c.arbitration_period_seconds;
  if(!Number.isInteger(cp)||cp<3600||cp>2592000 ||
     !Number.isInteger(ap)||ap<86400||ap>2592000) throw new Error('Invalid periods');
  return [c.token_address,...roles,per,total,cp,ap];
}
export async function buildIntent(c){
  const args=validateConfig(c);
  const artifact=JSON.parse(readFileSync('out/TransAtlasEscrow.sol/TransAtlasEscrow.json'));
  const tx=await new ContractFactory(artifact.abi,artifact.bytecode.object).getDeployTransaction(...args);
  return {chain_id:80002,transaction_kind:'contract_creation',data:tx.data,
    value_atomic:'0',broadcast:false,warning:'OFFLINE ONLY; no RPC, code, gas or role ownership verified'};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const config=JSON.parse(readFileSync(process.argv[2]??'config/amoy.json'));
    console.log(JSON.stringify(await buildIntent(config),null,2));
  }catch(e){console.error(e.message);process.exitCode=1}
}
