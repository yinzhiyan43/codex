import type {GitEntry} from "./repository.ts";

export type PatchLine = {kind:"header"|"context"|"add"|"remove"|"meta";oldLine:number|null;newLine:number|null;text:string};
export type PatchView = {lines:PatchLine[];limited:boolean;numberingComplete:boolean};
/** Number only actual hunk bodies. Patch filenames never become navigation targets. */
export function numberedPatch(text:string,maxLines=2000):PatchView {
  const source=text ? text.replace(/\n$/,"" ).split("\n") : [];
  const lines:PatchLine[]=[];let old:number|null=null,next:number|null=null,oldLeft=0,newLeft=0,complete=true;
  for(const text of source.slice(0,maxLines)) {
    const hunk=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if((text.startsWith("@@")&&!hunk)||/^diff --(?:cc|combined) /.test(text)){complete=false;old=next=null;oldLeft=newLeft=0;}
    if(hunk) {
      if(oldLeft||newLeft)complete=false;
      old=Number(hunk[1]);next=Number(hunk[3]);oldLeft=Number(hunk[2]??1);newLeft=Number(hunk[4]??1);
      if([old,next,oldLeft,newLeft].some(n=>!Number.isSafeInteger(n)||n<0||n>10000000)){old=next=null;oldLeft=newLeft=0;complete=false;}
      lines.push({kind:"header",oldLine:null,newLine:null,text});continue;
    }
    let kind:PatchLine["kind"]="meta",before:number|null=null,after:number|null=null;
    if(old!==null&&next!==null&&(oldLeft||newLeft)) {
      if(text.startsWith(" ")&&oldLeft>0&&newLeft>0){kind="context";before=old++;after=next++;oldLeft--;newLeft--;}
      else if(text.startsWith("-")&&oldLeft>0){kind="remove";before=old++;oldLeft--;}
      else if(text.startsWith("+")&&newLeft>0){kind="add";after=next++;newLeft--;}
      else if(!text.startsWith("\\ No newline")){complete=false;old=next=null;oldLeft=newLeft=0;}
    }
    lines.push({kind,oldLine:before,newLine:after,text});
  }
  const limited=source.length>maxLines;
  if(oldLeft||newLeft)complete=false;
  return {lines,limited,numberingComplete:complete&&!limited};
}
/** Untracked text is not a Git patch, even if it contains hunk-looking source. */
export function untrackedPreview(text:string):PatchView {const lines=text.replace(/\n$/, "").split("\n");return {lines:lines.slice(0,2000).map(text=>({kind:"meta",oldLine:null,newLine:null,text})),limited:lines.length>2000,numberingComplete:true};}
export type ChangeReview = {
  id:string;path:string;original:string|null;head:string|null;capturedAt:string;
  state:"snapshot"|"verified"|"stale";checkedAt:string|null;
  staged:PatchView;unstaged:PatchView;untracked:boolean;
};
export type IsolationPlan = {
  id:string;reviewId:string;sessionKey:string;sourcePath:string;baseCommit:string;
  suggestedName:string;mode:"detached";trackedAndUntrackedExcluded:true;ignoredExcluded:true;
  sharesGitMetadata:true;executionEnabled:false;createdAt:string;
};
export type CapturedReview = {entry:GitEntry;head:string|null;fingerprint:string;staged:string;unstaged:string};
