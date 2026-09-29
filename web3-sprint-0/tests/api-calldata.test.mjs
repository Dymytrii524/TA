// Invoked by check_api.py: stdin contains the actual parsed OpenAPI data schema,
// not a second hard-coded production pattern. This checks JS regex/byte parity,
// not a full JavaScript OpenAPI validator or a deployed HTTP handler.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {getBytes,Interface} from 'ethers';
const schema=JSON.parse(readFileSync(0,'utf8'));
assert.equal(schema.type,'string');
assert.equal(typeof schema.pattern,'string');
const pattern=new RegExp(schema.pattern);
const cases=JSON.parse(readFileSync(new URL('./fixtures/calldata.json',import.meta.url),'utf8'));
let positives=0,negatives=0;
for(const {name,data,valid} of cases){
  const accepted=typeof data==='string' && pattern.test(data);
  assert.equal(accepted,valid,`C03 JavaScript: ${name}`);
  if(valid){
    positives++;
    assert.equal(getBytes(data).length,(data.length-2)/2,`bytes decoder: ${name}`);
  }else negatives++;
}
// Exercise actual current ABI encoding, not only a hand-written selector fixture.
const abi=JSON.parse(readFileSync(new URL('../artifacts/TransAtlasEscrow.abi.json',import.meta.url),'utf8'));
const iface=new Interface(abi);
const calldata=iface.encodeFunctionData('withdraw',[]);
assert.equal(calldata,cases.find(c=>c.name==='withdraw-selector').data);
assert.ok(pattern.test(calldata));
assert.equal(iface.parseTransaction({data:calldata}).name,'withdraw');
// Prove the odd-byte regression detects the pre-fix pattern in this engine.
assert.equal(/^0x[0-9a-f]*$/.test(cases.find(c=>c.name==='odd-one-nibble').data),true);
console.log(`PASS C03 JavaScript regex parity: ${positives} positive, ${negatives} negative; byte decoding and actual withdraw ABI round-trip.`);
