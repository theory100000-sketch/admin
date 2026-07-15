(function(){
  'use strict';

  const MONTHS=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const WEEKDAYS=['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];
  const today=new Date();
  const calendarState={
    month:new Date(today.getFullYear(),today.getMonth(),1),
    selected:toIso(today),
    category:'todas'
  };
  let cachedData=null;
  let cachedNews=[];
  let applyPromise=null;
  let applyQueued=false;

  function $(selector,root=document){return root.querySelector(selector)}
  function $$(selector,root=document){return Array.from(root.querySelectorAll(selector))}
  function esc(value){return String(value??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]))}
  function norm(value){return String(value||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim()}
  function cleanName(value){return String(value||'Equipo').replace(/^\p{Extended_Pictographic}\s*/u,'').trim()}
  function toIso(date){
    const y=date.getFullYear();
    const m=String(date.getMonth()+1).padStart(2,'0');
    const d=String(date.getDate()).padStart(2,'0');
    return `${y}-${m}-${d}`;
  }
  function parseIso(value){
    const match=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(!match) return null;
    const date=new Date(Number(match[1]),Number(match[2])-1,Number(match[3]));
    return Number.isNaN(date.getTime())?null:date;
  }
  function niceMonth(date){return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`}
  function niceDate(value,long=true){
    const date=parseIso(value);
    if(!date) return 'Fecha por definir';
    return date.toLocaleDateString('es-ES',long?{weekday:'long',day:'numeric',month:'long',year:'numeric'}:{day:'2-digit',month:'short',year:'numeric'});
  }
  async function fetchJson(url,opts){
    try{
      const response=await fetch(url,Object.assign({cache:'no-store'},opts||{}));
      if(!response.ok) return null;
      return await response.json();
    }catch(error){return null}
  }

  function leagues(data){
    return (data?.competiciones||[]).filter(comp=>norm(comp?.tipo)==='liga');
  }
  function activeLeague(data){
    const list=leagues(data);
    return list.find(c=>norm(c.estado)==='activa'&&norm(c.nombre).includes('elite league')) ||
           list.find(c=>norm(c.estado)==='activa') || list[0] || null;
  }
  function clubMap(data){
    const map=new Map();
    (data?.clubes||[]).forEach(club=>{
      [club.nombre,club.nombreVisual,club.id].filter(Boolean).forEach(key=>map.set(norm(key),club));
    });
    return map;
  }
  function teamForSlot(data,comp,slotId){
    const slot=(comp?.equipos||[]).find(team=>String(team.slotId||team.id)===String(slotId))||{};
    const clubs=clubMap(data);
    const base=clubs.get(norm(slot.clubNombre||slot.nombre||slot.nombreVisual))||{};
    return {
      ...base,...slot,
      nombre:slot.clubNombre||base.nombre||cleanName(slot.nombre||slot.nombreVisual)||'Equipo',
      nombreVisual:slot.nombre||slot.nombreVisual||base.nombreVisual||base.nombre||slot.clubNombre||'Equipo',
      escudoUrl:slot.escudoUrl||slot.logoUrl||slot.escudo||base.escudoUrl||base.logoUrl||base.escudoPath||base.escudo||''
    };
  }
  function logoUrl(team){
    const value=String(team?.escudoUrl||team?.logoUrl||team?.logo||team?.escudo||team?.escudoPath||'').trim().replaceAll('\\','/');
    if(!value) return '';
    if(value.startsWith('/escudos/')) return value;
    if(value.startsWith('escudos/')) return '/'+value;
    if(/^escudo-.*\.(png|jpe?g|webp|gif)$/i.test(value)) return '/escudos/'+value;
    if(/^https?:\/\//i.test(value)) return '/api/logo?url='+encodeURIComponent(value);
    return value;
  }
  function crest(team,className='real-crest md'){
    const src=logoUrl(team);
    const name=cleanName(team?.nombreVisual||team?.nombre||team?.clubNombre||'Equipo');
    return src?`<span class="${className}"><img src="${esc(src)}" alt="${esc(name)}"></span>`:`<span class="${className}">${esc(team?.emoji||'⚡')}</span>`;
  }
  function validDatedMatches(comp){
    return (comp?.partidos||[]).filter(match=>parseIso(match.fecha));
  }
  function matchesByDate(comp){
    const map=new Map();
    validDatedMatches(comp).forEach(match=>{
      const key=String(match.fecha);
      if(!map.has(key)) map.set(key,[]);
      map.get(key).push(match);
    });
    for(const list of map.values()) list.sort((a,b)=>String(a.hora||'99:99').localeCompare(String(b.hora||'99:99')));
    return map;
  }
  function calendarCells(monthDate){
    const first=new Date(monthDate.getFullYear(),monthDate.getMonth(),1);
    const mondayOffset=(first.getDay()+6)%7;
    const start=new Date(first);
    start.setDate(first.getDate()-mondayOffset);
    return Array.from({length:42},(_,index)=>{
      const date=new Date(start);
      date.setDate(start.getDate()+index);
      return date;
    });
  }

  function renderMatchForDay(data,comp,match){
    const home=teamForSlot(data,comp,match.localSlotId);
    const away=teamForSlot(data,comp,match.visitanteSlotId);
    return `<div class="day-match real-day-match">
      <div class="day-time"><strong>${esc(match.hora||'--:--')}</strong><small>Jornada ${esc(match.jornada||'—')}</small></div>
      <div class="team-cell">${crest(home,'real-crest md')}<span class="team-name">${esc(cleanName(home.nombreVisual||home.nombre))}</span></div>
      <div class="versus">VS</div>
      <div class="team-cell right">${crest(away,'real-crest md')}<span class="team-name">${esc(cleanName(away.nombreVisual||away.nombre))}</span></div>
      <a class="day-cta" href="#">Ver partido</a>
      <div class="stadium">▣ Jornada ${esc(match.jornada||'—')}</div>
    </div>`;
  }

  function renderSelectedDay(data,comp,dateMap){
    const board=$('[data-subpanel="calendar"] .day-board');
    if(!board) return;
    const selected=calendarState.selected;
    const games=dateMap.get(selected)||[];
    const title=niceDate(selected,true);
    board.innerHTML=`<h4>${esc(title.charAt(0).toUpperCase()+title.slice(1))}</h4>`+
      (games.length?games.map(match=>renderMatchForDay(data,comp,match)).join(''):`<div class="tel-calendar-empty">No hay partidos con fecha asignada para este día.</div>`);
  }

  function renderMainCalendar(data,comp){
    const panel=$('[data-subpanel="calendar"] .month-panel');
    if(!panel) return;
    const dateMap=matchesByDate(comp);
    const currentMonth=calendarState.month;
    const selectedDate=parseIso(calendarState.selected);
    if(!selectedDate || selectedDate.getFullYear()!==currentMonth.getFullYear() || selectedDate.getMonth()!==currentMonth.getMonth()){
      const isCurrent=currentMonth.getFullYear()===today.getFullYear()&&currentMonth.getMonth()===today.getMonth();
      calendarState.selected=toIso(isCurrent?today:new Date(currentMonth.getFullYear(),currentMonth.getMonth(),1));
    }
    const head=$('.month-head',panel);
    if(head){
      head.innerHTML=`<button type="button" class="month-arrow" data-tel-cal-prev>‹</button><h3>${esc(niceMonth(currentMonth).toUpperCase())}</h3><button type="button" class="month-arrow" data-tel-cal-next>›</button>`;
    }
    const grid=$('.calendar-grid',panel);
    if(grid){
      const cells=calendarCells(currentMonth);
      grid.innerHTML=WEEKDAYS.map(day=>`<b>${day}</b>`).join('')+cells.map(date=>{
        const iso=toIso(date);
        const classes=[];
        if(date.getMonth()!==currentMonth.getMonth()) classes.push('off');
        if(iso===toIso(today)) classes.push('today');
        if(iso===calendarState.selected) classes.push('selected');
        if(dateMap.has(iso)) classes.push('has-game');
        return `<span class="${classes.join(' ')}" data-tel-date="${iso}">${date.getDate()}</span>`;
      }).join('');
      grid.querySelectorAll('[data-tel-date]').forEach(cell=>cell.addEventListener('click',()=>{
        const date=parseIso(cell.dataset.telDate);
        if(!date) return;
        calendarState.selected=cell.dataset.telDate;
        if(date.getMonth()!==calendarState.month.getMonth()||date.getFullYear()!==calendarState.month.getFullYear()){
          calendarState.month=new Date(date.getFullYear(),date.getMonth(),1);
        }
        renderCalendars(data,comp);
      }));
    }
    panel.querySelector('[data-tel-cal-prev]')?.addEventListener('click',()=>{
      calendarState.month=new Date(currentMonth.getFullYear(),currentMonth.getMonth()-1,1);
      renderCalendars(data,comp);
    });
    panel.querySelector('[data-tel-cal-next]')?.addEventListener('click',()=>{
      calendarState.month=new Date(currentMonth.getFullYear(),currentMonth.getMonth()+1,1);
      renderCalendars(data,comp);
    });
    const filter=$('[data-filter-group="calendar"] .filter-btn');
    if(filter){
      filter.innerHTML=`<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>${esc(niceMonth(currentMonth))} ⌄`;
    }
    renderSelectedDay(data,comp,dateMap);
  }

  function renderMiniCalendars(data,comp){
    const dateMap=matchesByDate(comp);
    const cells=calendarCells(calendarState.month);
    $$('.calendar-card').forEach(card=>{
      const month=$('.month',card);
      const mini=$('.mini-cal',card);
      if(month){
        month.innerHTML=`<button type="button" class="chev" data-tel-mini-prev>‹</button><span>${esc(niceMonth(calendarState.month))}</span><button type="button" class="chev" data-tel-mini-next>›</button>`;
      }
      if(mini){
        mini.innerHTML=WEEKDAYS.map(day=>`<b>${day}</b>`).join('')+cells.map(date=>{
          const iso=toIso(date);
          const classes=[];
          if(date.getMonth()!==calendarState.month.getMonth()) classes.push('m');
          if(iso===toIso(today)) classes.push('today');
          if(iso===calendarState.selected) classes.push('sel');
          if(dateMap.has(iso)) classes.push('has-game');
          return `<span class="${classes.join(' ')}" data-tel-mini-date="${iso}">${date.getDate()}</span>`;
        }).join('');
        mini.querySelectorAll('[data-tel-mini-date]').forEach(cell=>cell.addEventListener('click',()=>{
          const date=parseIso(cell.dataset.telMiniDate);
          if(!date) return;
          calendarState.selected=cell.dataset.telMiniDate;
          calendarState.month=new Date(date.getFullYear(),date.getMonth(),1);
          renderCalendars(data,comp);
        }));
      }
      card.querySelector('[data-tel-mini-prev]')?.addEventListener('click',()=>{
        calendarState.month=new Date(calendarState.month.getFullYear(),calendarState.month.getMonth()-1,1);
        renderCalendars(data,comp);
      });
      card.querySelector('[data-tel-mini-next]')?.addEventListener('click',()=>{
        calendarState.month=new Date(calendarState.month.getFullYear(),calendarState.month.getMonth()+1,1);
        renderCalendars(data,comp);
      });
    });
  }

  function datedMatchItems(data,comp){
    return validDatedMatches(comp).map(match=>({match,date:parseIso(match.fecha)})).sort((a,b)=>a.date-b.date||String(a.match.hora||'').localeCompare(String(b.match.hora||'')));
  }
  function eventHtml(data,comp,item){
    const match=item.match;
    const home=teamForSlot(data,comp,match.localSlotId);
    const away=teamForSlot(data,comp,match.visitanteSlotId);
    const date=item.date;
    return `<div class="event-item"><div class="event-date"><div><strong>${String(date.getDate()).padStart(2,'0')}</strong><span>${MONTHS[date.getMonth()].slice(0,3)}</span></div></div><div><h4>${esc(cleanName(home.nombre))} vs ${esc(cleanName(away.nombre))}</h4><p>${esc(niceDate(match.fecha,false))} · ${esc(match.hora||'--:--')} · Jornada ${esc(match.jornada||'—')}</p></div></div>`;
  }
  function renderRealEvents(data,comp){
    const items=datedMatchItems(data,comp);
    const nowIso=toIso(today);
    const upcoming=items.filter(item=>String(item.match.fecha)>=nowIso).slice(0,5);
    $$('[data-rail="calendar"] .rail-card').forEach(card=>{
      if(!norm(card.textContent).includes('proximos eventos')) return;
      const heading=card.querySelector('h3')?.outerHTML||'<h3 class="rail-title">Próximos eventos</h3>';
      card.innerHTML=heading+(upcoming.length?upcoming.map(item=>eventHtml(data,comp,item)).join(''):'<div class="tel-calendar-empty">No hay partidos con fecha asignada.</div>');
    });
    const newsEvents=$('#noticias .side-events');
    if(newsEvents){
      newsEvents.innerHTML='<h3>Próximos partidos <a class="rail-link" href="#partidos-calendario">Ver calendario</a></h3>'+(upcoming.length?upcoming.slice(0,3).map(item=>{
        const home=teamForSlot(data,comp,item.match.localSlotId);
        const away=teamForSlot(data,comp,item.match.visitanteSlotId);
        return `<div class="event-row"><div class="event-badge">⚽</div><div><h4>${esc(cleanName(home.nombre))} vs ${esc(cleanName(away.nombre))}</h4><p>Jornada ${esc(item.match.jornada||'—')}</p></div><div class="event-time">${String(item.date.getDate()).padStart(2,'0')} ${MONTHS[item.date.getMonth()].slice(0,3)}<br>${esc(item.match.hora||'--:--')}</div></div>`;
      }).join(''):'<div class="tel-calendar-empty">No hay partidos con fecha asignada.</div>');
    }
  }
  function renderCalendars(data,comp){
    renderMainCalendar(data,comp);
    renderMiniCalendars(data,comp);
    renderRealEvents(data,comp);
  }

  function standings(data,comp){
    const bySlot=new Map((comp?.equipos||[]).map((team,index)=>[String(team.slotId||team.id||index),team]));
    let rows=Array.isArray(comp?.clasificacion)&&comp.clasificacion.length?comp.clasificacion.map(row=>({...row})):(comp?.equipos||[]).map(team=>({...team,pj:0,pg:0,pe:0,pp:0,dg:0,gf:0,pts:0}));
    return rows.map((row,index)=>{
      const slotId=String(row.slotId||row.id||index);
      const slot=bySlot.get(slotId)||{};
      const team=teamForSlot(data,comp,row.slotId||slot.slotId||slot.id);
      return {...team,...slot,...row,nombre:row.clubNombre||slot.clubNombre||team.nombre,nombreVisual:row.nombre||slot.nombre||team.nombreVisual};
    }).sort((a,b)=>(Number(b.pts||b.puntos||0)-Number(a.pts||a.puntos||0))||(Number(b.dg||0)-Number(a.dg||0))||(Number(b.gf||0)-Number(a.gf||0))||cleanName(a.nombre).localeCompare(cleanName(b.nombre)));
  }
  function renderNewsStandings(data,comp){
    const card=$('#noticias .side-news-stand');
    if(!card) return;
    const rows=standings(data,comp).slice(0,5);
    card.innerHTML='<h3>Clasificación rápida <a class="rail-link" href="#clasificacion">Ver clasificación completa</a></h3>'+rows.map((row,index)=>`<div class="quick-row"><span>${index+1}</span>${crest(row,'real-crest sm')}<span class="name">${esc(cleanName(row.nombreVisual||row.nombre||row.clubNombre))}</span><span class="pts">${Number(row.pts||row.puntos||0)} pts</span></div>`).join('')+'<a class="all-stats" href="#clasificacion">Ver clasificación completa →</a>';
  }

  function categoryIcon(category){
    const value=norm(category);
    if(value.includes('torneo')) return '🏆';
    if(value.includes('resultado')) return '⚽';
    if(value.includes('reglamento')) return '📜';
    if(value.includes('comunidad')) return '👥';
    return '⚡';
  }
  function newsDate(value){
    const date=parseIso(value);
    return date?date.toLocaleDateString('es-ES',{day:'2-digit',month:'short',year:'numeric'}):'Sin fecha';
  }
  function storyVisual(news,large=false){
    return news.imagen?`<img class="tel-news-photo" src="${esc(news.imagen)}" alt="${esc(news.titulo)}">`:`<div class="visual">${categoryIcon(news.categoria)}</div>`;
  }
  function openNews(id){
    const item=cachedNews.find(news=>String(news.id)===String(id));
    if(!item) return;
    let modal=$('#telNewsModal');
    if(!modal){
      modal=document.createElement('div');modal.id='telNewsModal';modal.className='tel-news-modal';document.body.appendChild(modal);
    }
    modal.innerHTML=`<div class="tel-news-modal-box"><button class="tel-news-modal-close" type="button">Cerrar ×</button><div class="meta">${esc(item.categoria||'Anuncios')} · ${esc(newsDate(item.fecha))}</div><h2>${esc(item.titulo)}</h2><p>${esc(item.contenido||item.resumen||'')}</p></div>`;
    modal.classList.add('open');
    modal.querySelector('.tel-news-modal-close').onclick=()=>modal.classList.remove('open');
    modal.onclick=e=>{if(e.target===modal)modal.classList.remove('open')};
  }
  function filteredNews(){
    if(calendarState.category==='todas') return cachedNews;
    return cachedNews.filter(item=>norm(item.categoria)===calendarState.category);
  }
  function bindNewsActions(root=document){
    root.querySelectorAll('[data-news-id]').forEach(link=>link.addEventListener('click',event=>{event.preventDefault();openNews(link.dataset.newsId)}));
  }
  function renderHomeNews(){
    const panel=$$('.home-panel').find(card=>norm(card.querySelector('h2')?.textContent).includes('ultimas noticias'));
    if(!panel) return;
    const head='<div class="home-panel-head"><h2>Últimas noticias</h2><a class="see" href="#noticias">Ver todas</a></div>';
    panel.innerHTML=head+(cachedNews.length?cachedNews.slice(0,3).map(item=>`<div class="news-item"><div class="news-thumb">${item.imagen?`<img class="tel-news-photo" src="${esc(item.imagen)}" alt="">`:categoryIcon(item.categoria)}</div><div><span class="tag">${esc(item.categoria||'Anuncios')}</span><h4>${esc(item.titulo)}</h4><p>${esc(item.resumen)}</p><a href="#noticias" data-news-id="${esc(item.id)}">Leer más</a></div></div>`).join(''):'<div class="tel-news-empty">Todavía no hay noticias publicadas.</div>');
    bindNewsActions(panel);
  }
  function renderNewsSection(){
    const section=$('#noticias');if(!section)return;
    const list=filteredNews();
    const feature=$('.news-feature-wrap',section);
    const grid=$('.news-grid',section);
    const side=$('.side-list-card',section);
    if(!list.length){
      if(feature) feature.innerHTML='<div class="tel-news-empty">No hay noticias publicadas en esta categoría.</div>';
      if(grid) grid.innerHTML='';
    }else{
      const main=list[0];
      if(feature){
        feature.innerHTML=`<article class="feature-story"><div class="story-image">${storyVisual(main,true)}<div class="story-overlay"><b>Thunder</b><span>League</span></div></div><div class="story-copy"><span class="type">${esc(main.categoria||'Anuncios')}</span><h3>${esc(main.titulo)}</h3><span class="date">${esc(newsDate(main.fecha))}</span><p>${esc(main.resumen)}</p><a class="btn" href="#" data-news-id="${esc(main.id)}">Leer más</a></div></article><aside class="headline-box"><h3>Titulares</h3>${list.slice(1,5).map(item=>`<div class="headline-item"><span>${esc(item.titulo)}</span><span>${esc(newsDate(item.fecha))}</span></div>`).join('')||'<div class="tel-news-empty">Sin más titulares.</div>'}</aside>`;
      }
      if(grid){
        grid.innerHTML=list.slice(1).map(item=>`<article class="news-card"><div class="small-story-image">${storyVisual(item)}</div><div class="news-card-body"><span class="type">${esc(item.categoria||'Anuncios')}</span><span class="date">${esc(newsDate(item.fecha))}</span><h4>${esc(item.titulo)}</h4><p>${esc(item.resumen)}</p><a class="read-more" href="#" data-news-id="${esc(item.id)}">Leer más <span>→</span></a></div></article>`).join('')||'<div class="tel-news-empty">No hay más noticias publicadas.</div>';
      }
    }
    if(side){
      side.innerHTML='<h3>Últimas noticias <a class="rail-link" href="#noticias">Ver todas</a></h3>'+(cachedNews.length?cachedNews.slice(0,4).map(item=>`<div class="side-news-item"><div class="thumb-mini">${categoryIcon(item.categoria)}</div><div><h4>${esc(item.titulo)}</h4><p>${esc(newsDate(item.fecha))}</p></div></div>`).join(''):'<div class="tel-news-empty">Todavía no hay noticias publicadas.</div>');
    }
    const tabs=$$('.news-tab',section);
    tabs.forEach(tab=>{
      const label=norm(tab.textContent);
      tab.classList.toggle('active',calendarState.category==='todas'?label==='todas':label===calendarState.category);
      tab.onclick=event=>{
        event.preventDefault();
        calendarState.category=label==='todas'?'todas':label;
        renderNewsSection();
      };
    });
    bindNewsActions(section);
  }
  function renderNews(data,comp,news){
    cachedNews=(news||[]).slice().sort((a,b)=>(Date.parse(b.fecha||b.creadoEn||0)||0)-(Date.parse(a.fecha||a.creadoEn||0)||0));
    renderHomeNews();
    renderNewsSection();
    renderNewsStandings(data,comp);
  }

  async function refreshAdminAccess(){
    const status=await fetchJson('/api/admin/status');
    const admin=!!status?.admin;
    document.body.classList.toggle('tel-admin-authorized',admin);
    if(!admin) $$('.tel-panel-admin-link').forEach(link=>link.remove());
  }

  async function apply(){
    if(applyPromise){
      applyQueued=true;
      return applyPromise;
    }
    applyPromise=(async()=>{
      const [data,newsPayload,status]=await Promise.all([
        fetchJson('/api/data'),
        fetchJson('/api/noticias'),
        fetchJson('/api/admin/status')
      ]);
      if(!data) return;
      const comp=activeLeague(data);
      cachedData=data;
      if(comp){
        renderCalendars(data,comp);
        renderNewsStandings(data,comp);
      }
      renderNews(data,comp,newsPayload?.noticias||[]);
      const admin=!!status?.admin;
      document.body.classList.toggle('tel-admin-authorized',admin);
      if(!admin) $$('.tel-panel-admin-link').forEach(link=>link.remove());
    })();
    try{ await applyPromise; }
    finally{
      applyPromise=null;
      if(applyQueued){
        applyQueued=false;
        setTimeout(apply,80);
      }
    }
  }

  window.telRefreshPublic=async function(){
    await apply();
    // Existing section renderers already listen to hashchange; trigger them without reloading.
    try{ window.dispatchEvent(new Event('hashchange')); }catch(e){}
  };

  document.addEventListener('DOMContentLoaded',()=>setTimeout(apply,100));
  window.addEventListener('hashchange',()=>setTimeout(()=>{
    if(cachedData){
      const comp=activeLeague(cachedData);
      if(comp) renderCalendars(cachedData,comp);
      renderNews(cachedData,comp,cachedNews);
    }else apply();
  },120));
  window.addEventListener('tel:auth-changed',refreshAdminAccess);
  window.addEventListener('tel:data-updated',()=>setTimeout(apply,100));
})();
