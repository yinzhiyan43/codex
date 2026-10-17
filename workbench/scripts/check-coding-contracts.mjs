// Read-only source provenance check. Never invoke Codex, schema generation or a sandbox probe.
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),repo=fileURLToPath(new URL('../../',import.meta.url));
const manifest=JSON.parse(readFileSync(root+'contracts/coding/manifest.json','utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
if(manifest.coreCommit!=='092d3acd6bec3e3a14bdc7e7a2810ab628ab759d'||manifest.liveTransportEnabled!==false||manifest.nativeValidationAuthorized!==false||manifest.sourceSubsetsAreBinaryGenerated!==false)throw Error('coding-contract-boundary-changed');
for(const [path,expected]of Object.entries(manifest.sources)){
 const pinned=execFileSync('git',['show',manifest.coreCommit+':'+path],{cwd:repo});
 if(hash(pinned)!==expected||!readFileSync(repo+path).equals(pinned))throw Error('coding-source-drift');
}
for(const entry of Object.values(manifest.entries)){
 const bytes=readFileSync(root+entry.path);if(hash(bytes)!==entry.sha256)throw Error('coding-contract-drift');
 if(entry.source&&!bytes.equals(execFileSync('git',['show',manifest.coreCommit+':'+entry.source],{cwd:repo})))throw Error('coding-export-drift');
}
const thread=readFileSync(repo+'codex-rs/app-server-protocol/src/protocol/v2/thread.rs','utf8'),turn=readFileSync(repo+'codex-rs/app-server-protocol/src/protocol/v2/turn.rs','utf8');
for(const field of manifest.experimentalFields){const source=field.startsWith('turn/')?turn:thread;if(!source.includes('#[experimental("'+field+'")'))throw Error('coding-field-provenance-missing');}
const expected=['manifest.json',...Object.values(manifest.entries).map(e=>e.path.split('/').at(-1))].sort();if(JSON.stringify(readdirSync(root+'contracts/coding').sort())!==JSON.stringify(expected))throw Error('unexpected-coding-contract-file');
console.log('Verified 2 pinned exports and explicitly source-derived experimental subsets; live coding transport remains disabled');
