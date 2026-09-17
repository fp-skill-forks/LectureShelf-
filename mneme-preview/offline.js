(()=>{
  const KEY='lectureshelf-mini-v1';
  const DB='mneme-offline-v1';
  const STORE='articles';
  const $=id=>document.getElementById(id);
  const getLibrary=()=>{try{return JSON.parse(localStorage.getItem(KEY)||'{}')}catch{return{items:[]}}};
  const putLibrary=d=>localStorage.setItem(KEY,JSON.stringify(d));
  const esc=s=>String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  let dbPromise=null;
  let offlineUid='';
  let scrollTimer=null;
  const offlineIds=new Set();

  function eligible(x){
    if(!x||x.type!=='link'||!x.url)return false;
    try{return !new URL(x.url).pathname.toLowerCase().endsWith('.pdf')}catch{return false}
  }
  function db(){
    if(dbPromise)return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      const r=indexedDB.open(DB,1);
      r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains(STORE))r.result.createObjectStore(STORE,{keyPath:'uid'})};
      r.onsuccess=()=>resolve(r.result);
      r.onerror=()=>reject(r.error);
    });
    return dbPromise;
  }
  async function tx(mode,fn){
    const d=await db();
    return new Promise((resolve,reject)=>{
      const t=d.transaction(STORE,mode),s=t.objectStore(STORE);
      let result;
      try{result=fn(s)}catch(e){reject(e);return}
      t.oncomplete=()=>resolve(result);
      t.onerror=()=>reject(t.error);
      t.onabort=()=>reject(t.error);
    });
  }
  async function read(uid){
    const d=await db();
    return new Promise((resolve,reject)=>{
      const r=d.transaction(STORE,'readonly').objectStore(STORE).get(uid);
      r.onsuccess=()=>resolve(r.result||null);
      r.onerror=()=>reject(r.error);
    });
  }
  const write=rec=>tx('readwrite',s=>s.put(rec));
  const remove=uid=>tx('readwrite',s=>s.delete(uid));
  async function loadIds(){
    const d=await db();
    return new Promise((resolve,reject)=>{
      const r=d.transaction(STORE,'readonly').objectStore(STORE).getAllKeys();
      r.onsuccess=()=>resolve(r.result||[]);
      r.onerror=()=>reject(r.error);
    });
  }

  function inlineMd(s){
    let out=esc(s);
    out=out.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
    out=out.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\*([^*]+)\*/g,'<em>$1</em>');
    return out;
  }
  function renderMarkdown(md){
    const lines=String(md||'').split('\n'),html=[];let p=[];
    const flush=()=>{if(p.length){html.push('<p>'+inlineMd(p.join(' '))+'</p>');p=[]}};
    for(let line of lines){
      line=line.trim();
      if(!line){flush();continue}
      let m;
      if((m=line.match(/^###\s+(.+)/))){flush();html.push('<h3>'+inlineMd(m[1])+'</h3>')}
      else if((m=line.match(/^##\s+(.+)/))){flush();html.push('<h2>'+inlineMd(m[1])+'</h2>')}
      else if((m=line.match(/^#\s+(.+)/))){flush();html.push('<h1>'+inlineMd(m[1])+'</h1>')}
      else if((m=line.match(/^>\s*(.+)/))){flush();html.push('<blockquote>'+inlineMd(m[1])+'</blockquote>')}
      else if(/^!\[/.test(line)){continue}
      else p.push(line);
    }
    flush();
    return html.join('');
  }
  function parseReader(txt){
    let title='';
    for(const l of String(txt).replace(/\r/g,'').split('\n').slice(0,15)){
      const m=l.match(/^Title:\s*(.+)$/i);if(m){title=m[1].trim();break}
    }
    const body=String(txt).replace(/^Title:.*$/mi,'').replace(/^URL Source:.*$/mi,'').replace(/^Published Time:.*$/mi,'').replace(/^Markdown Content:\s*/mi,'').trim();
    return{title,body};
  }
  function item(uid){return(getLibrary().items||[]).find(x=>x.uid===uid)}
  function uidFromItemCard(card){
    const b=card.querySelector('.more');
    const m=(b?.getAttribute('onclick')||'').match(/Mneme\.menu\(event,'([^']+)'\)/);
    return m?.[1]||'';
  }
  function decorate(){
    document.querySelectorAll('.mnemeOfflineBadge').forEach(b=>b.remove());
    document.querySelectorAll('.item').forEach(card=>{
      const uid=uidFromItemCard(card);
      if(!uid||!offlineIds.has(uid))return;
      const tags=card.querySelector('.tags');
      if(tags){const b=document.createElement('span');b.className='tag mnemeOfflineBadge';b.textContent='Offline';tags.appendChild(b)}
    });
    document.querySelectorAll('.continueCard').forEach(card=>{
      const m=(card.getAttribute('onclick')||'').match(/Mneme\.openItem\('([^']+)'\)/),uid=m?.[1]||'';
      if(!uid||!offlineIds.has(uid))return;
      const meta=card.querySelector('.meta');
      if(meta){const b=document.createElement('span');b.className='mnemeOfflineBadge';b.textContent=' · Offline';meta.appendChild(b)}
    });
  }
  async function download(uid){
    const d=getLibrary(),x=(d.items||[]).find(i=>i.uid===uid);
    if(!eligible(x))return;
    try{
      let raw=x.readerCached||'';
      if(!raw){
        const r=await fetch('https://r.jina.ai/'+x.url,{cache:'no-store'});
        if(!r.ok)throw new Error('fetch');
        raw=await r.text();
      }
      if(!raw.trim())throw new Error('empty');
      const p=parseReader(raw);
      await write({uid:x.uid,url:x.url,title:p.title||x.title||'',raw,savedAt:Date.now()});
      offlineIds.add(uid);
      if(!x.title&&p.title)x.title=p.title;
      if(x.readerCached)delete x.readerCached;
      x.updated=Date.now();
      putLibrary(d);
      decorate();
      alert('Available offline.');
    }catch(e){
      alert('This article could not be downloaded for offline reading.');
    }
  }
  async function removeDownload(uid){
    try{
      await remove(uid);
      offlineIds.delete(uid);
      const d=getLibrary(),x=(d.items||[]).find(i=>i.uid===uid);
      if(x?.readerCached)delete x.readerCached;
      if(x){x.updated=Date.now();putLibrary(d)}
      decorate();
      alert('Offline copy removed.');
    }catch{alert('The offline copy could not be removed.')}
  }

  function saveOfflineProgress(){
    if(!offlineUid)return;
    const d=getLibrary(),x=(d.items||[]).find(i=>i.uid===offlineUid),s=$('readerScroll');
    if(!x||!s)return;
    const max=Math.max(1,s.scrollHeight-s.clientHeight);
    x.readPct=Math.max(0,Math.min(100,s.scrollTop/max*100));
    x.updated=Date.now();
    if(x.readPct>97)x.done=true;
    putLibrary(d);
    if($('readerBar'))$('readerBar').style.width=x.readPct+'%';
  }
  function openOfflineReader(x,rec){
    offlineUid=x.uid;
    const p=parseReader(rec.raw);
    $('readerTitle').textContent=x.title||p.title||'Reader';
    $('readerBar').style.width=(x.readPct||0)+'%';
    $('article').innerHTML=(x.note?'<div class="readerNote">'+esc(x.note)+'</div>':'')+renderMarkdown(p.body);
    $('readerBackdrop').classList.add('show');
    requestAnimationFrame(()=>{
      const s=$('readerScroll'),max=Math.max(0,s.scrollHeight-s.clientHeight);
      s.scrollTop=max*(Math.max(0,Math.min(100,x.readPct||0))/100);
    });
  }

  const baseOpen=window.Mneme?.openItem?.bind(window.Mneme);
  if(baseOpen){
    Mneme.openItem=async function(uid){
      const x=item(uid);
      if(eligible(x)&&offlineIds.has(uid)){
        try{
          const rec=await read(uid);
          if(rec){openOfflineReader(x,rec);return}
          offlineIds.delete(uid);decorate();
        }catch{}
      }
      return baseOpen(uid);
    };
  }

  const baseMenu=window.Mneme?.menu?.bind(window.Mneme);
  if(baseMenu){
    Mneme.menu=function(e,uid){
      baseMenu(e,uid);
      setTimeout(()=>{
        const m=document.querySelector('.menu'),x=item(uid);
        if(!m||!eligible(x))return;
        const b=document.createElement('button');
        b.textContent=offlineIds.has(uid)?'Remove offline copy':'Download for offline';
        b.onclick=ev=>{
          ev.preventDefault();ev.stopPropagation();m.remove();
          if(offlineIds.has(uid))removeDownload(uid);else download(uid);
        };
        m.appendChild(b);
      },0);
    };
  }

  if(window.MnemeMedia){
    const baseClose=MnemeMedia.closeReader.bind(MnemeMedia);
    const baseExternal=MnemeMedia.openExternalReader.bind(MnemeMedia);
    MnemeMedia.closeReader=function(){
      if(offlineUid){saveOfflineProgress();$('readerBackdrop').classList.remove('show');offlineUid='';return}
      return baseClose();
    };
    MnemeMedia.openExternalReader=function(){
      if(offlineUid){const x=item(offlineUid);if(x)window.open(x.url,'_blank','noopener');return}
      return baseExternal();
    };
  }

  const scroll=$('readerScroll');
  if(scroll)scroll.addEventListener('scroll',()=>{if(!offlineUid)return;clearTimeout(scrollTimer);scrollTimer=setTimeout(saveOfflineProgress,140)});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)saveOfflineProgress()});
  window.addEventListener('pagehide',saveOfflineProgress);

  const view=$('view');
  if(view)new MutationObserver(()=>requestAnimationFrame(decorate)).observe(view,{childList:true,subtree:true});
  loadIds().then(ids=>{ids.forEach(id=>offlineIds.add(String(id)));decorate()}).catch(()=>{});
  window.MnemeOffline={download,remove:removeDownload,isSaved:uid=>offlineIds.has(uid)};
})();
