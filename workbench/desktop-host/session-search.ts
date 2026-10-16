import type { WorkbenchClient } from "./client.ts";
import type { PreviewSource } from "./session-preview.ts";
export type SearchKind = "content" | "title";
export type SessionSearchView = {
  term:string; archived:boolean; kind:SearchKind; rows:{id:string;title:string;snippet:string}[];
  loading:boolean; inflight:boolean; stale:boolean; more:boolean; notice:string;
};
type Query={intent:number;term:string;archived:boolean;kind:SearchKind;cursor:string|null;generation:number};
/** Query-local, volatile catalog. One physical read plus one replaceable latest intent.
 * Cancel invalidates results; it never interrupts shared core work or model turns. */
export class SessionSearch {
  #client:WorkbenchClient;#off:()=>void;#listeners=new Set<()=>void>();#disposed=false;#generation:number;
  #intent=0;#active=false;#pending:Query|null=null;#cursor:string|null=null;#seen=new Set<string>();
  #view:SessionSearchView={term:"",archived:false,kind:"content",rows:[],loading:false,inflight:false,stale:true,more:false,notice:"搜索已保存会话；选择正文或标题/预览，并明确归档范围。"};
  constructor(client:WorkbenchClient){this.#client=client;this.#generation=client.getView().generation;this.#off=client.subscribe(()=>{
    const host=client.getView();if(host.generation!==this.#generation||host.state!=="ready"){
      this.#generation=host.generation;this.cancel();this.#view.notice="连接已改变，搜索结果已失效；重连后请重新搜索。";this.#publish();
    }
  });}
  subscribe(fn:()=>void):()=>void{this.#listeners.add(fn);return()=>this.#listeners.delete(fn);}
  #publish():void{if(!this.#disposed)for(const fn of this.#listeners)try{fn();}catch{}}
  snapshot():SessionSearchView{return structuredClone({...this.#view,inflight:this.#active});}
  #ready():void{if(this.#disposed||this.#client.getView().state!=="ready")throw new Error("search-offline");}
  search(term:string,archived:boolean,kind:SearchKind):void{
    this.#ready();term=term.trim();if(!term||term.length>128||/[\x00-\x1f]/.test(term)||typeof archived!=="boolean"||!["content","title"].includes(kind))throw new Error("invalid-search");
    this.#intent++;this.#seen.clear();this.#cursor=null;
    this.#view={term,archived,kind,rows:[],loading:true,inflight:this.#active,stale:true,more:false,notice:this.#active?"等待先前搜索返回，随后搜索最新关键词…":"正在搜索已保存会话…"};
    this.#pending={intent:this.#intent,term,archived,kind,cursor:null,generation:this.#client.getView().generation};this.#publish();void this.#drain();
  }
  more():void{
    this.#ready();if(this.#active||this.#view.loading||this.#view.stale||!this.#view.more||!this.#cursor)return;
    this.#view.loading=true;this.#pending={intent:this.#intent,term:this.#view.term,archived:this.#view.archived,kind:this.#view.kind,cursor:this.#cursor,generation:this.#client.getView().generation};this.#publish();void this.#drain();
  }
  cancel():void{this.#intent++;this.#pending=null;this.#cursor=null;this.#view.loading=false;this.#view.more=false;this.#view.stale=true;this.#view.notice="搜索已取消；旧结果不可打开，已发送的只读请求可能仍在返回。";this.#publish();}
  source(id:string):PreviewSource{
    this.#ready();if(this.#view.stale||this.#view.loading)throw new Error("search-result-stale");const row=this.#view.rows.find(row=>row.id===id);if(!row)throw new Error("unknown-search-result");
    return {id:row.id,title:row.title,archived:this.#view.archived};
  }
  async #drain():Promise<void>{
    if(this.#active||this.#disposed)return;this.#active=true;
    try{while(this.#pending&&!this.#disposed){const q=this.#pending;this.#pending=null;
      const current=()=>!this.#disposed&&q.intent===this.#intent&&q.generation===this.#client.getView().generation&&this.#client.getView().state==="ready";
      try{
        const params={searchTerm:q.term,cursor:q.cursor,limit:20,sortKey:"created_at" as const,sortDirection:"desc" as const,archived:q.archived};
        const response=q.kind==="content"?await this.#client.searchThreads(params):await this.#client.listThreads({...params,modelProviders:[]});
        if(!current())continue;
        const key=JSON.stringify(q.cursor);
        if(this.#seen.has(key)||response.nextCursor!==null&&(response.nextCursor===q.cursor||this.#seen.has(JSON.stringify(response.nextCursor))))throw new Error("search-cursor-loop");
        const rows=q.cursor===null?[]:[...this.#view.rows];
        for(const item of response.data){const thread="thread" in item?item.thread:item;
          if(!/^[a-z0-9-]{1,64}$/.test(thread.id)||thread.ephemeral)throw new Error("invalid-search-thread");
          const clean=(s:string,limit:number)=>s.replace(/[\x00-\x1f\x7f]/g," ").replace(/\s+/g," ").slice(0,limit);
          const row={id:thread.id,title:clean(thread.name||thread.preview||"未命名会话",100),snippet:"snippet" in item?clean(item.snippet,240):"标题/预览匹配 · 在只读副窗查看保存记录"};
          const at=rows.findIndex(row=>row.id===thread.id);if(at<0)rows.push(row);else rows[at]=row;
        }
        if(rows.length>100||this.#seen.size>=16)throw new Error("search-display-limit");
        this.#seen.add(key);this.#cursor=response.nextCursor;const limited=rows.length>=100||this.#seen.size>=16;
        this.#view.rows=rows;this.#view.stale=false;this.#view.more=!limited&&response.nextCursor!==null;
        this.#view.notice=limited&&response.nextCursor!==null?"已达展示上限（100条/16页），请缩小关键词后重新搜索。":rows.length?`已显示 ${rows.length} 条${q.archived?"已归档":"未归档"}结果${response.nextCursor!==null?"，可继续加载":""}。`:"此范围内没有匹配结果；可更换关键词、正文/标题预览或归档范围。";
      }catch{if(current()){this.#cursor=null;this.#view.more=false;this.#view.stale=true;this.#view.notice="搜索未完成或游标已失效；已有结果保留但不可打开，请重新搜索。正文搜索需要当前官方存储支持。";}}
      finally{if(current())this.#view.loading=false;this.#publish();}
    }}finally{this.#active=false;this.#publish();}
  }
  dispose():void{this.#disposed=true;this.#intent++;this.#pending=null;this.#off();this.#listeners.clear();}
}
