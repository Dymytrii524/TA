// Invoke the pinned native tool directly and preserve its exit status.
// The upstream npm wrapper 1.7.1 returned 0 after failed Forge tests in verification.
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {spawn} from 'node:child_process';
const require=createRequire(import.meta.url);
const [tool,...args]=process.argv.slice(2);
if(!['forge','anvil'].includes(tool)) throw new Error('Expected forge or anvil');
const os={linux:'linux',darwin:'darwin',win32:'win32'}[process.platform];
const arch={x64:'amd64',arm64:'arm64'}[process.arch];
if(!os||!arch) throw new Error('Unsupported platform');
const packagePath=require.resolve(`@foundry-rs/${tool}-${os}-${arch}/package.json`);
const binary=join(dirname(packagePath),'bin',tool+(os==='win32'?'.exe':''));
const child=spawn(binary,args,{stdio:'inherit'});
child.on('error',error=>{console.error(error);process.exit(1)});
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));
child.on('exit',(code,signal)=>{process.exit(code??(signal?1:0))});
