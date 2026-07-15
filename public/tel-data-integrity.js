(function(){
  'use strict';
  const root=document.documentElement;
  const nativeFetch=window.fetch ? window.fetch.bind(window) : null;
  let officialData=null;
  let readyQueued=false;

  function norm(value){
    return String(value||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
  }
  function clean(value){
    return String(value||'').replace(/^(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}|\s)+/u,'').trim();
  }
  function logo(item){
    let value=String(item?.escudoUrl||item?.logoUrl||item?.escudoPath||item?.escudoFilename||item?.logo||item?.escudo||'').trim().replaceAll('\\','/');
    if(!value) return '';
    if(value.startsWith('/escudos/')) return value;
    if(value.startsWith('escudos/')) return '/'+value;
    if(/^escudo-.*\.(?:png|jpe?g|webp|gif|svg)$/i.test(value)) return '/escudos/'+value;
    return value;
  }
  function normalizeData(data){
    if(!data || typeof data!=='object') return data;
    const clubs=Array.isArray(data.clubes)?data.clubes:(Array.isArray(data.equipos)?data.equipos:[]);
    const clubsMap=new Map();
    const put=(map,key,obj)=>{if(!key)return;map.set(String(key),obj);map.set(norm(key),obj)};
    clubs.forEach(club=>{
      const src=logo(club); if(src) club.escudoUrl=src;
      [club.id,club._id,club.clubId,club.nombre,club.nombreVisual,club.clubNombre,club.name].forEach(k=>put(clubsMap,k,club));
    });
    const findClub=source=>{
      const values=typeof source==='string'?[source]:[source?.clubId,source?.id,source?._id,source?.clubNombre,source?.nombre,source?.nombreVisual,source?.name];
      for(const value of values){const hit=clubsMap.get(String(value||''))||clubsMap.get(norm(value));if(hit)return hit}
      return null;
    };
    const comps=Array.isArray(data.competiciones)?data.competiciones:[];
    comps.forEach(comp=>{
      const teamMap=new Map();
      comp.equipos=(Array.isArray(comp.equipos)?comp.equipos:[]).map(team=>{
        const base=findClub(team)||{};
        const out={...base,...team};
        out.clubNombre=team.clubNombre||base.nombre||clean(team.nombre||team.nombreVisual)||'Equipo';
        out.nombre=team.nombre||team.nombreVisual||base.nombreVisual||base.nombre||out.clubNombre;
        out.nombreVisual=team.nombreVisual||team.nombre||base.nombreVisual||base.nombre||out.clubNombre;
        out.escudoUrl=logo(team)||logo(base);
        return out;
      });
      comp.equipos.forEach((team,index)=>[team.slotId,team.id,team.clubId,team.clubNombre,team.nombre,team.nombreVisual,team.name,`slot-${index+1}`].forEach(k=>put(teamMap,k,team)));
      const resolve=(ref,name)=>teamMap.get(String(ref||''))||teamMap.get(norm(ref))||teamMap.get(String(name||''))||teamMap.get(norm(name))||findClub(name||ref)||null;
      if(Array.isArray(comp.clasificacion)) comp.clasificacion=comp.clasificacion.map(row=>{
        const base=resolve(row.slotId||row.clubId||row.id,row.clubNombre||row.nombre||row.nombreVisual)||{};
        return {...base,...row,escudoUrl:logo(row)||logo(base)};
      });
      if(Array.isArray(comp.partidos)) comp.partidos.forEach(match=>{
        const home=resolve(match.localSlotId||match.localClubId,match.localNombre||match.nombreLocal);
        const away=resolve(match.visitanteSlotId||match.visitanteClubId,match.visitanteNombre||match.nombreVisitante);
        if(home){match.localNombre=clean(home.clubNombre||home.nombre||home.nombreVisual);match.localLogo=logo(home);match.localEscudo=match.localLogo}
        if(away){match.visitanteNombre=clean(away.clubNombre||away.nombre||away.nombreVisual);match.visitanteLogo=logo(away);match.visitanteEscudo=match.visitanteLogo}
      });
    });
    officialData=data;
    window.__telOfficialData=data;
    return data;
  }
  function normalizePanel(payload){
    if(!payload || !Array.isArray(payload.matches) || !officialData) return payload;
    const comps=new Map((officialData.competiciones||[]).map(c=>[String(c.id||c.nombre),c]));
    payload.matches=payload.matches.map(item=>{
      const comp=comps.get(String(item.compId||''));
      const match=(comp?.partidos||[]).find(m=>String(m.id||'')===String(item.id||''));
      return match ? {...item,localNombre:match.localNombre||item.localNombre,visitanteNombre:match.visitanteNombre||item.visitanteNombre,localLogo:match.localLogo||item.localLogo,visitanteLogo:match.visitanteLogo||item.visitanteLogo} : item;
    });
    return payload;
  }
  function markReady(){
    if(readyQueued) return;
    readyQueued=true;
    requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(()=>{
      root.classList.remove('tel-official-data-loading');
      root.classList.add('tel-official-data-ready');
      try{window.dispatchEvent(new CustomEvent('tel:official-data-ready',{detail:{data:officialData}}))}catch(e){}
    },120)));
  }
  function rebuiltResponse(response,payload){
    const headers=new Headers(response.headers);
    headers.delete('content-length');headers.delete('content-encoding');
    headers.set('content-type','application/json; charset=utf-8');
    headers.set('cache-control','no-store');
    return new Response(JSON.stringify(payload),{status:response.status,statusText:response.statusText,headers});
  }
  function relevantUrl(input){
    try{return new URL(typeof input==='string'?input:input.url,location.href).pathname}catch(e){return ''}
  }
  if(nativeFetch){
    window.fetch=async function(input,init){
      const response=await nativeFetch(input,init);
      const path=relevantUrl(input);
      if(!response.ok) return response;
      if(/^\/api\/(?:data|data-live|data-live-normal)$/.test(path)){
        try{const payload=normalizeData(await response.clone().json());markReady();return rebuiltResponse(response,payload)}catch(e){return response}
      }
      if(path==='/api/tel-panel/matches'){
        try{const payload=normalizePanel(await response.clone().json());markReady();return rebuiltResponse(response,payload)}catch(e){return response}
      }
      return response;
    };
  }
  window.telNormalizeOfficialData=normalizeData;

  function fixImage(img){
    if(!(img instanceof HTMLImageElement)) return;
    let src=img.getAttribute('src')||'';
    if(src.startsWith('escudos/')){src='/'+src;img.setAttribute('src',src)}
    if(src.includes('/escudos/')){
      img.style.setProperty('object-fit','contain','important');
      img.style.setProperty('box-sizing','border-box','important');
      if(!img.dataset.telLogoFallback){
        img.dataset.telLogoFallback='1';
        img.addEventListener('error',()=>{
          const current=img.getAttribute('src')||'';
          if(current.includes('/api/logo?')) return;
          const local=current.includes('/escudos/')?current.slice(current.indexOf('/escudos/')):'';
          if(local) img.src='/api/logo?url='+encodeURIComponent(local);
        },{once:true});
      }
    }
  }
  function scan(node=document){
    if(node instanceof HTMLImageElement) fixImage(node);
    node.querySelectorAll?.('img').forEach(fixImage);
  }
  new MutationObserver(records=>records.forEach(record=>record.addedNodes.forEach(node=>node.nodeType===1&&scan(node)))).observe(document.documentElement,{subtree:true,childList:true});

  root.classList.add('tel-official-data-loading');
  document.addEventListener('DOMContentLoaded',()=>{
    scan();
    if(nativeFetch && !officialData){
      nativeFetch('/api/data?integrity='+Date.now(),{cache:'no-store'})
        .then(r=>r.ok?r.json():null).then(data=>{if(data)normalizeData(data);markReady()}).catch(markReady);
    }else markReady();
  });
  setTimeout(markReady,8000);
})();
