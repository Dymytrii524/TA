// Local fault controls. Restore every file even if a test crashes or times out.
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const cases=[
  ['promotion','runtime/finality.mjs',"if(old.state==='finalized'){",
    "if(old.state!=='finalized')throw Error('mutant refuses promotion'); if(old.state==='finalized'){",'tests/finality.test.mjs'],
  ['skip-unknown','runtime/wallet.mjs','const t=terms.find(t=>t.escrow_id===e.escrowId);',
    'const t=terms.find(t=>t.escrow_id===e.escrowId); if(!t)continue;','tests/subsets.test.mjs'],
  ['subset-is-global','runtime/wallet.mjs',"Object.values(ledger.balances).reduce",
    "Object.values(ledger.ta_balances).reduce",'tests/subsets.test.mjs'],
  ['duplicate-allocation','runtime/wallet.mjs','const allocations=pending.map',
    'const allocations=pending.concat(pending).map','tests/subsets.test.mjs'],
  ['mask-ta-mismatch','runtime/subsets.mjs',"throw Error('TA_MISMATCH');",
    "return {dealId:null,provenance:'UNATTRIBUTED',payerCompany:null,carrierCompany:null};",'tests/subsets.test.mjs'],
  ['default-409','runtime/wallet.mjs',"send(503,{type:'about:blank'",
    "send(409,{type:'about:blank'",'tests/http-errors.test.mjs'],
];
let detected=0;
for(const [name,path,before,after,test] of cases){
  const original=readFileSync(path,'utf8');
  if(!original.includes(before))throw Error('mutation target missing '+name);
  try{
    writeFileSync(path,original.replace(before,after));
    const env={...process.env};delete env.WEB3_TEST_DATABASE_URL;
    const r=spawnSync(process.execPath,[test],{env,encoding:'utf8',timeout:90000});
    // A timeout, syntax/import failure or signal is NOT evidence of detection.
    if(r.error||r.signal||r.status===0||/SyntaxError|ERR_MODULE_NOT_FOUND/.test(r.stderr))
      throw Error('mutation not detected by assertion '+name+'\n'+r.stderr);
    if(!/AssertionError/.test(r.stderr))throw Error('mutation lacks assertion evidence '+name+'\n'+r.stderr);
    detected++;console.log('PASS mutation detected '+name);
  }finally{writeFileSync(path,original)}
}
console.log(JSON.stringify({detected,total:cases.length}));
