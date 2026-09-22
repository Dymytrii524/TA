import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateConfig,buildIntent} from '../tools/amoy_intent.mjs';
const base=JSON.parse(readFileSync('config/amoy.json'));
assert.throws(()=>validateConfig(base));console.log('PASS unresolved role addresses fail closed');
const c={...base,guardian:'0x0000000000000000000000000000000000000001',
  arbiter:'0x0000000000000000000000000000000000000002',
  backup_arbiter:'0x0000000000000000000000000000000000000003'};
assert.throws(()=>validateConfig({...c,chain_id:137}));console.log('PASS mainnet intent denied');
assert.throws(()=>validateConfig({...c,broadcast_enabled:true}));console.log('PASS broadcast denied');
assert.throws(()=>validateConfig({...c,arbiter:c.guardian}));console.log('PASS duplicate roles denied');
const tx=await buildIntent(c);
assert.equal(tx.chain_id,80002);assert.equal(tx.broadcast,false);assert.match(tx.data,/^0x[0-9a-f]+$/i);
console.log('PASS offline constructor calldata generated with dummy test roles');
console.log('Amoy config checks: 5 passed; no external deployment or RPC.');
