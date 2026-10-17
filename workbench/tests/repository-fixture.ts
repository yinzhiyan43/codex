import {mkdtemp,realpath,mkdir,writeFile,rename,symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
const exec=promisify(execFile);
export async function syntheticRepositoryRoots(parent?:string){
 const directory=parent??await realpath(await mkdtemp(join(tmpdir(),"workbench-repository-test-")));await mkdir(directory,{recursive:true});const roots={a:join(directory,"roots","a"),b:join(directory,"roots","b")};
 const git=async(root:string,...args:string[])=>{await exec("/usr/bin/git",["-c","core.hooksPath=/dev/null","-c","init.templateDir=","-c","commit.gpgsign=false","-c","user.name=Synthetic","-c","user.email=fixture@example.invalid",...args],{cwd:root,env:{PATH:"/usr/bin:/bin",HOME:directory,LANG:"C",LC_ALL:"C",GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null"},timeout:5000,maxBuffer:524288});};
 for(const [label,root]of Object.entries(roots)){await mkdir(join(root,"nested"),{recursive:true});await git(root,"init","-q","--initial-branch=main");await writeFile(join(root,"tracked.txt"),"initial "+label+"\n");await writeFile(join(root,"old.txt"),"rename "+label+"\n");await writeFile(join(root,"nested","source.txt"),"nested "+label+"\n");await git(root,"add","--all");await git(root,"commit","-qm","synthetic baseline");await writeFile(join(root,"tracked.txt"),"staged "+label+"\n");await git(root,"add","tracked.txt");await writeFile(join(root,"tracked.txt"),"unstaged "+label+"\n");await rename(join(root,"old.txt"),join(root,"renamed.txt"));await git(root,"add","--all");await writeFile(join(root,"tracked.txt"),"working "+label+"\n");await writeFile(join(root,"new.txt"),"untracked "+label+"\n");}
 await writeFile(join(directory,"outside.txt"),"OUTSIDE SYNTHETIC CANARY");await symlink(join(directory,"outside.txt"),join(roots.a,"outside-link"));await symlink(roots.b,join(roots.a,"other-root-link"));return {directory,roots,git};
}
