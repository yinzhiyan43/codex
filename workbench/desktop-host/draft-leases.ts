import {randomBytes} from "node:crypto";
import type {SessionStore} from "./session-store.ts";
/** Process-local ownership. Durable draft text stays in the existing serialized store. */
export class DraftLeases {
  #store:SessionStore;
  #revisions=new Map<string,{text:string;revision:number}>();
  #leases=new Map<string,{owner:string;token:string}>();
  #writing=new Set<string>();
  constructor(store:SessionStore){this.#store=store;}
  state(key:string){
    const text=this.#store.confirmedDraft(key),previous=this.#revisions.get(key);
    const revision=previous?previous.revision+(previous.text===text?0:1):0;
    this.#revisions.set(key,{text,revision});return {text,revision,...(this.#leases.get(key)??{owner:null,token:null})};
  }
  owns(key:string,owner:string):boolean{return this.#leases.get(key)?.owner===owner;}
  claim(key:string,owner:string):void{const prior=this.#leases.get(key);if(prior&&prior.owner!==owner)throw new Error("editor-occupied");if(!prior)this.#leases.set(key,{owner,token:"edit-"+randomBytes(16).toString("hex")});this.state(key);}
  busy(key:string):boolean{return this.#writing.has(key);}
  release(key:string,owner:string):void{if(this.#writing.has(key))throw new Error("draft-save-inflight");if(this.owns(key,owner))this.#leases.delete(key);}
  async write(key:string,owner:string,revision:number,token:string,text:string,persist:()=>Promise<unknown>):Promise<void>{
    const state=this.state(key);
    if(state.owner!==owner||state.token!==token)throw new Error("editor-lease-expired");
    if(state.revision!==revision)throw new Error("draft-version-conflict");
    if(this.#writing.has(key))throw new Error("draft-save-inflight");
    if(text.length>4000||text.includes("\0"))throw new Error("invalid-draft");
    this.#writing.add(key);try{await persist();this.state(key);}finally{this.#writing.delete(key);}
  }
}
