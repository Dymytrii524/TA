// Actual local RPC/EVM transactions. No external network, wallet keys or real tokens.
import {JsonRpcProvider,ContractFactory,Interface,keccak256,toUtf8Bytes,toQuantity} from 'ethers';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const url=process.env.ANVIL_URL??'http://127.0.0.1:8545';
const parsed=new URL(url);
if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)) throw new Error('Local RPC only');
const rpc=new JsonRpcProvider(url,31337,{staticNetwork:true,cacheTimeout:-1});
rpc.pollingInterval=100;
const artifact=name=>JSON.parse(readFileSync(`out/${name}.sol/${name}.json`));
const escrowArtifact=artifact('TransAtlasEscrow');
let checks=0;
const pass=s=>{checks++;console.log(`PASS ${s}`)};
const send=async p=>{const receipt=await(await p).wait();assert.equal(receipt.status,1);return receipt};
const mine=async()=>{await rpc.send('evm_mine',[]);await rpc.send('evm_mine',[])};
const hash=s=>keccak256(toUtf8Bytes(s));

// Acceptance fixture, not production indexer. Two-block rule is LOCAL ONLY.
class Projection {
  constructor(address){this.address=address.toLowerCase();this.seen=new Set();this.states=new Map()}
  async consume(receipt){
    if(receipt.status!==1) throw new Error('failed receipt');
    const block=await rpc.send('eth_getBlockByNumber',[toQuantity(receipt.blockNumber),false]);
    if(!block||block.hash!==receipt.blockHash) throw new Error('orphaned receipt');
    const head=Number(await rpc.send('eth_blockNumber',[]));
    if(head-receipt.blockNumber<2) return 'included';
    const iface=new Interface(escrowArtifact.abi);
    for(const log of receipt.logs){
      if(log.address.toLowerCase()!==this.address) continue;
      const key=`31337:${receipt.blockHash}:${receipt.hash}:${log.index}`;
      if(this.seen.has(key)) continue;
      const event=iface.parseLog(log);
      if(event?.name==='StateChanged') this.states.set(event.args.id,Number(event.args.state));
      this.seen.add(key);
    }
    return 'finalized';
  }
}
try{
  assert.equal(Number(await rpc.send('eth_chainId',[])),31337);pass('local chain guard');
  const s=await Promise.all([0,1,2,3,4,5].map(i=>rpc.getSigner(i)));
  const addr=await Promise.all(s.map(x=>x.getAddress()));
  const mt=artifact('MockUSDC');
  const token=await new ContractFactory(mt.abi,mt.bytecode.object,s[0]).deploy();
  await token.waitForDeployment();
  const escrow=await new ContractFactory(escrowArtifact.abi,escrowArtifact.bytecode.object,s[0])
    .deploy(await token.getAddress(),addr[2],addr[3],addr[4],10000n*10n**6n,100000n*10n**6n,86400,604800);
  await escrow.waitForDeployment();pass('real contract deployment on Anvil');
  const eaddr=await escrow.getAddress();
  const projection=new Projection(eaddr);
  await send(token.mint(addr[0],10000n*10n**6n));
  await send(token.approve(eaddr,10000n*10n**6n));
  const ts=Number((await rpc.send('eth_getBlockByNumber',['latest',false])).timestamp);
  const snapshot=await rpc.send('evm_snapshot',[]);
  const orphan=hash('orphan');
  const orphanReceipt=await send(escrow.create(orphan,addr[1],100n,ts+3600,ts+864000,hash('terms')));
  assert.equal(await projection.consume(orphanReceipt),'included');
  assert.equal(projection.states.size,0);pass('unconfirmed receipt does not project');
  assert.equal(await rpc.send('evm_revert',[snapshot]),true);
  await assert.rejects(()=>projection.consume(orphanReceipt),/orphaned/);
  assert.equal(projection.states.size,0);pass('actual pre-finality reorg rejected');
  const id=hash('e2e-delivery');
  const amount=1000n*10n**6n;
  let receipt=await send(escrow.create(id,addr[1],amount,ts+3600,ts+864000,hash('terms')));
  await mine();assert.equal(await projection.consume(receipt),'finalized');
  assert.equal(projection.states.get(id),1);pass('finalized funding projection');
  const seen=projection.seen.size;await projection.consume(receipt);
  assert.equal(projection.seen.size,seen);pass('duplicate receipt idempotent');
  const terms=(await escrow.getDeal(id)).termsHash;
  await assert.rejects(()=>escrow.connect(s[5]).accept.staticCall(id,terms));pass('unauthorized transaction simulation rejected');
  receipt=await send(escrow.connect(s[1]).accept(id,terms));await mine();await projection.consume(receipt);
  assert.equal(projection.states.get(id),2);
  const evidence=hash('private evidence + random secret nonce fixture');
  receipt=await send(escrow.connect(s[1]).submitDelivery(id,evidence));await mine();await projection.consume(receipt);
  assert.equal(projection.states.get(id),3);pass('carrier delivery does not pay');
  receipt=await send(escrow.approveDelivery(id,evidence));await mine();await projection.consume(receipt);
  assert.equal(projection.states.get(id),4);
  await assert.rejects(()=>escrow.finalize.staticCall(id));pass('challenge window enforced over RPC');
  await rpc.send('evm_increaseTime',[86400]);await mine();
  receipt=await send(escrow.finalize(id));await mine();await projection.consume(receipt);
  assert.equal(projection.states.get(id),6);assert.equal(await escrow.claimable(addr[1]),amount);
  assert.equal(await token.balanceOf(addr[1]),0n);pass('settlement is claim, not paid status');
  await send(token.setPaused(true));
  await assert.rejects(()=>escrow.connect(s[1]).withdraw.staticCall());
  assert.equal(await escrow.claimable(addr[1]),amount);pass('failed transfer preserves claim');
  await send(token.setPaused(false));
  const withdrawal=await send(escrow.connect(s[1]).withdraw());
  assert.equal(await token.balanceOf(addr[1]),amount);assert.equal(await escrow.totalClaimable(),0n);
  assert.equal(await escrow.totalDeposited(),await escrow.totalWithdrawn());pass('withdraw and reconciliation');
  await assert.rejects(()=>escrow.finalize.staticCall(id));pass('repeated settlement rejected over RPC');
  // A fresh projection replays confirmed receipts; no mutable localStorage authority.
  const restart=new Projection(eaddr);
  await restart.consume(receipt);assert.equal(restart.states.get(id),6);pass('receipt replay after observer restart');
  console.log(JSON.stringify({network:'LOCAL ANVIL ONLY',escrow:eaddr,token:await token.getAddress(),
    settlementTx:receipt.hash,withdrawalTx:withdrawal.hash,checks,amoyDeployed:false},null,2));
} finally {rpc.destroy()}
