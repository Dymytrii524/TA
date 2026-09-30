import {JsonRpcProvider,ContractFactory,keccak256,toUtf8Bytes} from 'ethers';
import {readFileSync} from 'node:fs';
import {createFixture,u} from './p1-fixture.mjs';
import {postgresFixtureDB} from './pg-adapter.mjs';
import {recordMappingPreflight} from '../runtime/mapping-evidence.mjs';
export const hash=s=>keccak256(toUtf8Bytes(s));
export async function r21Fixture({preflight=true}={}){
  const url=process.env.ANVIL_URL??'http://127.0.0.1:8545';
  if(!['localhost','127.0.0.1'].includes(new URL(url).hostname))throw Error('local only');
  const rpc=new JsonRpcProvider(url,31337,{staticNetwork:true,cacheTimeout:-1});rpc.pollingInterval=30;
  const s=await Promise.all([0,1,2,3,4,5,6].map(i=>rpc.getSigner(i)));
  const addr=await Promise.all(s.map(x=>x.getAddress()));
  const send=async p=>(await p).wait();
  const deploy=async(name,args=[])=>{
    const a=JSON.parse(readFileSync(`out/${name}.sol/${name}.json`));
    const c=await new ContractFactory(a.abi,a.bytecode.object,s[0]).deploy(...args);
    await c.waitForDeployment();return c;
  };
  const token=await deploy('MockUSDC');
  const escrow=await deploy('TransAtlasEscrow',[await token.getAddress(),...addr.slice(2,5),10000000000n,100000000000n,86400,604800]);
  const contract=(await escrow.getAddress()).toLowerCase();
  const ts=Number((await rpc.send('eth_getBlockByNumber',['latest',false])).timestamp);
  const f=await createFixture({contract,token:await token.getAddress(),payer:addr[0],carrier:addr[1],
    arbiter:addr[3],backup:addr[4],nonce:hash('r21-known'),amount:'600',
    acceptBy:ts+86400,deliveryBy:ts+864000,codeHash:keccak256(await rpc.getCode(contract))},
    process.env.WEB3_TEST_DATABASE_URL?{db:await postgresFixtureDB()}:{});
  await f.db.query('INSERT INTO web3.wallet_permissions VALUES($1,$2,true)',[u(4),u(1)]);
  await send(token.mint(addr[0],100000n));await send(token.approve(contract,100000n));
  await send(token.mint(addr[5],100000n));await send(token.connect(s[5]).approve(contract,100000n));
  if(preflight)await recordMappingPreflight(f.db,rpc,u(10));
  const create=async(nonce,amount=400,payer=0,carrier=1)=>{
    const receipt=await send(escrow.connect(s[payer]).create(nonce,addr[carrier],amount,
      f.t.acceptBy,f.t.deliveryBy,hash('r21-external'),2));
    const id=await escrow.deriveEscrowId(addr[payer],nonce);
    return {id,receipt,settle:()=>send(escrow.connect(s[carrier]).cancelUnaccepted(id))};
  };
  const mine=async()=>{await rpc.send('evm_mine',[]);await rpc.send('evm_mine',[])};
  const close=async()=>{await f.db.close();rpc.destroy()};
  return {...f,rpc,s,addr,send,token,escrow,contract,create,mine,close};
}
