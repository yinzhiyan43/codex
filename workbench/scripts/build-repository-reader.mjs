import {execFileSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));mkdirSync(root+'.desktop',{recursive:true});
if(process.platform!=='darwin')throw new Error('repository-reader-macos-required');
const git=execFileSync('/usr/bin/xcrun',['--find','git'],{encoding:'utf8',timeout:5000,env:{PATH:'/usr/bin:/bin'}}).trim();
if(!git.startsWith('/')||/[\x00-\x1f"\\]/.test(git))throw new Error('invalid-system-git');
execFileSync('/usr/bin/clang',['-std=c11','-Wall','-Wextra','-Werror','-Wno-deprecated-declarations','-O2','-DWB_GIT="'+git+'"',root+'native/repository-reader.c','-o',root+'.desktop/repository-reader'],{env:{PATH:'/usr/bin:/bin'},timeout:30000});
console.log('Built bounded repository read helper');
