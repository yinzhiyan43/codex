import type {RepositoryView} from "../domain/repository.ts";
import type {PatchView} from "../domain/change-review.ts";
import type {DesktopCommand} from "../desktop-host/ipc-contract.ts";
export function setupChangeReview(container:HTMLElement,send:(command:DesktopCommand)=>void){
 container.innerHTML='<h3>本地变更审阅快照</h3><p id="review-facts" role="status"></p><p>已暂存：HEAD → 索引；未暂存：索引 → 当前工作文件。这里只展示本地差异，不运行模型审查。</p><div class="repo-actions"><button id="review-verify" type="button">重新核对快照</button><button id="review-current" type="button">查看当前工作文件</button><button id="review-plan" type="button">生成隔离工作区计划</button></div><label for="review-range">审阅范围</label> <select id="review-range"><option value="staged">已暂存</option><option value="unstaged">未暂存 / 未跟踪</option></select><p id="review-limit" role="status"></p><div id="review-lines" tabindex="0" role="region" aria-label="差异旧行号、新行号和内容"></div><section id="isolation-plan" hidden><h3>隔离工作区计划（尚未创建）</h3><pre id="isolation-facts" tabindex="0"></pre><p>从此提交建立独立的 detached 工作目录；不会复制暂存、未暂存、未跟踪或忽略文件。Git对象和部分元数据仍共享，不是安全沙箱。既有会话cwd和草稿保持原位。</p><p>本轮仅提供计划，创建、绑定与清理尚未开放；清理必须另行确认且不能自动丢弃内容。</p></section>';
 const el=<T extends HTMLElement=HTMLElement>(id:string)=>container.querySelector('#'+id) as T;
 let current:RepositoryView|undefined,last="";
 for(const [id,type]of [["review-verify","repoVerifyReview"],["review-current","repoReviewFile"],["review-plan","repoPlanIsolation"]]as const)el(id).onclick=()=>{if(current?.review&&!current.busy)send({type,scope:current.scope,review:current.review.id});};
 const draw=(patch:PatchView|undefined)=>{
  const fragment=document.createDocumentFragment();
  for(const line of patch?.lines??[]){const row=document.createElement('div');row.className='review-line review-'+line.kind;for(const n of [line.oldLine,line.newLine]){const cell=document.createElement('span');cell.className='review-number';cell.textContent=n===null?'':String(n);row.append(cell);}const text=document.createElement('span');text.className='review-source';text.textContent=line.text;row.append(text);fragment.append(row);}
  if(!fragment.childNodes.length){const empty=document.createElement('p');empty.textContent='此范围没有差异。';fragment.append(empty);}
  el('review-lines').replaceChildren(fragment);
  el('review-limit').textContent=patch?.limited?'仅显示前2000行，后续未渲染；完整补丁仍受读取上限限制。':patch&&!patch.numberingComplete?'补丁不能完整编号；没有推断文件定位。':'旧/新行号属于补丁版本；不自动跳转到当前文件。二进制和说明行没有行号。';
 };
 const selected=()=>current?.review?.[el<HTMLSelectElement>('review-range').value==='staged'?'staged':'unstaged'];
 el('review-range').onchange=()=>draw(selected());
 return {render(view:RepositoryView|undefined){
  current=view;const review=view?.review;el<HTMLSelectElement>('review-range').querySelector<HTMLOptionElement>('[value=unstaged]')!.textContent=review?.untracked?'未跟踪文本（不是Git补丁）':'未暂存 / 未跟踪';container.hidden=!review;if(!review){last='';el('review-lines').replaceChildren();el('review-facts').textContent='';el('isolation-facts').textContent='';el('isolation-plan').hidden=true;return;}
  el('review-facts').textContent=(review.state==='stale'?'已过期':review.state==='verified'?'本次核对未发现变化':'读取快照')+' · '+(review.original?review.original+' → ':'')+review.path+' · HEAD '+(review.head??'尚无提交')+' · 读取 '+review.capturedAt+(review.checkedAt?' · 核对 '+review.checkedAt:'');
  if(last!==review.id){last=review.id;el<HTMLSelectElement>('review-range').value=review.staged.lines.length?'staged':'unstaged';draw(selected());el('review-lines').scrollTop=0;}
  for(const id of ['review-verify','review-current','review-plan'])el<HTMLButtonElement>(id).disabled=!!view?.busy||review.state==='stale'&&id!=='review-current'||id==='review-plan'&&!review.head;
  const plan=view?.isolation;el('isolation-plan').hidden=!plan;el('isolation-facts').textContent=plan?'会话：'+plan.sessionKey+'\n来源：'+plan.sourcePath+'\n固定提交：'+plan.baseCommit+'\n建议目录名：'+plan.suggestedName+'\n目标父目录：尚未选择\n模式：detached HEAD\n执行：未开放；未创建目录或移动会话':'';
 }};
}
