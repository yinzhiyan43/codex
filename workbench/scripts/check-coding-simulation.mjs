// Explicitly audited pure protocol/state or Node fake-peer tests only.
// Do not replace with npm test: that target runs native repository/worktree tests.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
if(process.argv.length!==2)throw Error('coding-simulation-no-options');
const files=['coding-preparation','chat-bootstrap','core-controller','desktop','full-turns-window','history-browser','host','jsonl','keyboard-policy','official-chat','official-config','pagination','session','session-search','session-editing-contracts'].map(name=>'tests/'+name+'.test.ts');
const result=spawnSync(process.execPath,['--test','--test-timeout=15000',...files],{cwd:root,env:{PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},stdio:'inherit',shell:false,timeout:60000});
if(result.error||result.status!==0)throw Error('coding-simulation-check-failed');
console.log('Simulation-only selection complete; no Codex/native isolation/repository/worktree/UI tests run');
