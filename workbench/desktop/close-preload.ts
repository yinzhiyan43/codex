import {ipcRenderer} from "electron";
export type CloseProof={key:string;revision:number;lease:string|null;text:string}|null;
export function createCloseBridge(){let registered=false;return Object.freeze({onRequest:(prepare:()=>Promise<CloseProof>,failed:()=>void):(()=>void)=>{
 if(registered)throw new Error("close-handler-already-registered");registered=true;
 if(typeof prepare!=="function"||typeof failed!=="function")throw new Error("invalid-close-handler");
 const request=(_event:unknown,nonce:string)=>{if(typeof nonce!=="string"||!/^close-[a-f0-9]{32}$/.test(nonce))return;void(async()=>{try{const proof=await prepare();await ipcRenderer.invoke("workbench:close-ready",{nonce,ok:true,proof});}catch{failed();await ipcRenderer.invoke("workbench:close-ready",{nonce,ok:false,proof:null}).catch(()=>{});}})();};
 const failure=()=>failed();ipcRenderer.on("workbench:close-request",request);ipcRenderer.on("workbench:close-failed",failure);return()=>{registered=false;ipcRenderer.off("workbench:close-request",request);ipcRenderer.off("workbench:close-failed",failure);};
}});}
