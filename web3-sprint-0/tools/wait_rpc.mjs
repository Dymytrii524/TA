const url='http://127.0.0.1:8545';
let ready=false;
for(let i=0;i<60;i++){
  try{
    const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]}),
      signal:AbortSignal.timeout(1000)});
    if((await r.json()).result==='0x7a69'){ready=true;break;}
  }catch{}
  await new Promise(r=>setTimeout(r,500));
}
if(!ready) throw new Error('Local Anvil readiness timeout or wrong chain');
console.log('Local Anvil ready');
