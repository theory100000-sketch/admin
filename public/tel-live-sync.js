(function(){
  'use strict';

  const pathName = String(location.pathname || '/').toLowerCase();
  const isAdminPage = pathName.includes('panel-');
  const nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  const stateKey = 'tel:live-page-state';
  const crossTabKey = 'tel:cross-tab-update';
  const ownWriteWindowMs = 1800;

  let ownWriteUntil = 0;
  let refreshTimer = null;
  let pendingWhileHidden = false;
  let lastVersion = '';
  let refreshing = false;
  let source = null;
  let channel = null;

  function isMutatingRequest(input, init){
    const method = String((init && init.method) || 'GET').toUpperCase();
    const url = typeof input === 'string' ? input : String(input && input.url || '');
    return !['GET','HEAD','OPTIONS'].includes(method) && /\/api\//.test(url);
  }

  function announceCrossTab(version){
    const payload = {version:String(version || Date.now()), at:Date.now()};
    try{ channel?.postMessage(payload); }catch(error){}
    try{ localStorage.setItem(crossTabKey, JSON.stringify(payload)); }catch(error){}
  }

  if('BroadcastChannel' in window){
    try{
      channel = new BroadcastChannel('tel-live-updates');
      channel.onmessage = event => onRemoteUpdate(event?.data?.version || 'broadcast');
    }catch(error){}
  }

  if(nativeFetch){
    window.fetch = function(input, init){
      const mutates = isMutatingRequest(input, init);
      if(mutates){
        ownWriteUntil = Date.now() + ownWriteWindowMs;
        window.__telOwnWriteUntil = ownWriteUntil;
      }
      return nativeFetch(input, init).then(response => {
        if(mutates && response && response.ok){
          announceCrossTab(Date.now());
          // La vista que ha realizado el guardado también se comprueba después.
          scheduleRefresh(isAdminPage ? 700 : 950, true);
        }
        return response;
      });
    };
  }

  function emitUpdate(){
    try{ window.dispatchEvent(new CustomEvent('tel:data-updated',{detail:{remote:true}})); }catch(error){}
  }

  function savePageState(){
    try{
      sessionStorage.setItem(stateKey, JSON.stringify({
        path:location.pathname,
        hash:location.hash,
        x:window.scrollX || 0,
        y:window.scrollY || 0,
        at:Date.now()
      }));
    }catch(error){}
  }

  function restorePageState(){
    try{
      const raw = sessionStorage.getItem(stateKey);
      if(!raw) return;
      const state = JSON.parse(raw);
      if(!state || state.path !== location.pathname || Date.now() - Number(state.at || 0) > 15000) return;
      sessionStorage.removeItem(stateKey);
      if(state.hash && location.hash !== state.hash) history.replaceState(null,'',location.pathname + location.search + state.hash);
      requestAnimationFrame(()=>requestAnimationFrame(()=>window.scrollTo(Number(state.x)||0, Number(state.y)||0)));
    }catch(error){}
  }

  function userIsEditing(){
    const element = document.activeElement;
    if(!element) return false;
    const tag = String(element.tagName || '').toLowerCase();
    return element.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select';
  }

  async function refreshAdminPage(){
    if(refreshing) return;
    if(window.__telAutosaveBusy || window.__telFormDirty || userIsEditing()){
      scheduleRefresh(900, true);
      return;
    }
    refreshing = true;
    try{
      const refreshFn = typeof window.telRefreshCurrent === 'function' ? window.telRefreshCurrent : null;
      if(refreshFn){
        if(pathName.endsWith('/panel-competiciones.html')){
          const id = document.getElementById('competitionId')?.value || '';
          await refreshFn(id);
        }else{
          await refreshFn();
        }
        emitUpdate();
        return;
      }
      // Nunca recargamos el documento completo. Si el panel no expone una
      // función de refresco, notificamos el cambio para que sus componentes
      // actualicen solo el contenido necesario.
      emitUpdate();
    }catch(error){
      console.warn('[TEL live sync] Actualización silenciosa de administración fallida:', error);
      emitUpdate();
    }finally{
      refreshing = false;
    }
  }

  async function refreshPublicPage(){
    if(userIsEditing()){
      scheduleRefresh(1000, true);
      return;
    }
    refreshing = true;
    try{
      // Actualiza datos y vistas sin recargar el documento completo. Así no se
      // reinicia el router ni se pierde/reevalúa la sesión durante el acceso.
      if(typeof window.telRefreshPublic === 'function'){
        await window.telRefreshPublic();
        emitUpdate();
        return;
      }
      emitUpdate();
    }catch(error){
      console.warn('[TEL live sync] Refresco público fallido:', error);
    }finally{
      refreshing = false;
    }
  }

  function doRefresh(){
    refreshTimer = null;
    if(document.hidden){
      pendingWhileHidden = true;
      return;
    }
    if(isAdminPage) refreshAdminPage();
    else refreshPublicPage();
  }

  function scheduleRefresh(delay, includeOwnWrite){
    if(!includeOwnWrite && Date.now() < Math.max(ownWriteUntil, Number(window.__telOwnWriteUntil || 0))){
      delay = Math.max(Number(delay) || 0, 900);
    }
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(doRefresh, Number(delay) || 450);
  }

  function onRemoteUpdate(version){
    const nextVersion = String(version || '');
    if(nextVersion && nextVersion === lastVersion) return;
    if(nextVersion) lastVersion = nextVersion;
    scheduleRefresh(450, false);
  }

  function connectSse(){
    if(!('EventSource' in window)) return;
    try{
      source = new EventSource('/api/live-updates');
      source.addEventListener('data-updated', event => {
        let version = '';
        try{ version = JSON.parse(event.data || '{}').version || ''; }catch(error){}
        onRemoteUpdate(version || event.lastEventId || 'sse');
      });
      source.onerror = function(){ /* EventSource vuelve a conectar solo. */ };
      window.__telLiveSource = source;
    }catch(error){
      console.warn('[TEL live sync] SSE no disponible:', error);
    }
  }

  async function pollVersion(triggerWhenFirstLoaded){
    if(!nativeFetch) return;
    try{
      const response = await nativeFetch('/api/data-version?ts=' + Date.now(), {cache:'no-store'});
      if(!response.ok) return;
      const payload = await response.json();
      const version = String(payload.version || '');
      if(!lastVersion){
        lastVersion = version;
        if(triggerWhenFirstLoaded) scheduleRefresh(120, true);
        return;
      }
      if(version && version !== lastVersion){
        lastVersion = version;
        scheduleRefresh(350, false);
      }
    }catch(error){}
  }

  window.addEventListener('storage', event => {
    if(event.key !== crossTabKey || !event.newValue) return;
    try{ onRemoteUpdate(JSON.parse(event.newValue).version || 'storage'); }
    catch(error){ onRemoteUpdate('storage'); }
  });

  document.addEventListener('visibilitychange', function(){
    if(!document.hidden){
      pollVersion(false);
      if(pendingWhileHidden){
        pendingWhileHidden = false;
        scheduleRefresh(120, true);
      }
    }
  });
  window.addEventListener('focus', ()=>pollVersion(false));
  window.addEventListener('online', ()=>pollVersion(false));

  document.addEventListener('DOMContentLoaded', function(){
    restorePageState();
    /* En Vercel se usa sondeo: evita mantener una función serverless abierta con SSE. */
    if(nativeFetch){
      nativeFetch('/api/health', {cache:'no-store'})
        .then(response=>response.ok ? response.json() : null)
        .then(health=>{ if(health && health.runtime !== 'vercel') connectSse(); })
        .catch(()=>{});
    }
    pollVersion(false);
    // Comprobación ligera permanente: mantiene sincronizadas las distintas instancias.
    setInterval(()=>pollVersion(false), 7000);
  });

  window.addEventListener('beforeunload', ()=>{
    try{ source?.close(); }catch(error){}
    try{ channel?.close(); }catch(error){}
  });
})();
