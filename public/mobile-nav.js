// Mobile hamburger menu — shared across pages.
// Pages render their .app-header as usual (with .nav-pill links, .me, #logout).
// Below 768px the pills and right-hand signout collapse into a hamburger drawer
// that mirrors the same links. JS reads links from the header so each page's
// existing role-gating just works (hidden pills stay hidden in the drawer).
(function(){
  function $(s,r){return (r||document).querySelector(s);}
  function $$(s,r){return Array.from((r||document).querySelectorAll(s));}

  function build(){
    const header=$('.app-header');
    if(!header||header.dataset.mobileNav==='1')return;
    header.dataset.mobileNav='1';

    // Insert hamburger into .hdr-right (create it if the header has no right side)
    let right=$('.hdr-right',header);
    if(!right){
      right=document.createElement('div');
      right.className='hdr-right';
      header.appendChild(right);
    }
    if(!$('.hamburger',right)){
      const btn=document.createElement('button');
      btn.className='hamburger';
      btn.type='button';
      btn.setAttribute('aria-label','Menu');
      btn.setAttribute('aria-expanded','false');
      btn.innerHTML='<span></span><span></span><span></span>';
      right.appendChild(btn);
    }

    // Create the drawer overlay if missing
    let drawer=$('#nav-drawer');
    if(!drawer){
      drawer=document.createElement('div');
      drawer.id='nav-drawer';
      drawer.className='nav-drawer';
      drawer.innerHTML='<div class="nav-drawer-panel"><div class="nav-drawer-links"></div><div class="nav-drawer-footer"><div class="nav-drawer-me"></div><button type="button" class="nav-drawer-signout">Sign out</button></div></div>';
      document.body.insertBefore(drawer,document.body.firstChild.nextSibling);
    }
  }

  function sync(){
    const drawer=$('#nav-drawer'); if(!drawer)return;
    const linksBox=$('.nav-drawer-links',drawer);
    const meBox=$('.nav-drawer-me',drawer);
    const signoutBtn=$('.nav-drawer-signout',drawer);
    // Mirror visible .nav-pill links
    const pills=$$('.app-header .nav-pill').filter(a=>a.offsetParent!==null||a.style.display!=='none');
    // offsetParent is null if parent hidden; fallback: check computed display
    const visible=$$('.app-header .nav-pill').filter(a=>getComputedStyle(a).display!=='none');
    linksBox.innerHTML='';
    (visible.length?visible:pills).forEach(a=>{
      const clone=document.createElement('a');
      clone.href=a.getAttribute('href');
      clone.className='nav-drawer-link'+(a.classList.contains('active')?' active':'');
      clone.textContent=a.textContent.trim();
      clone.addEventListener('click',close);
      linksBox.appendChild(clone);
    });
    // Mirror user name
    const me=$('.app-header .me');
    meBox.textContent=me?me.textContent:'';
    // Wire signout → delegate to header's existing signout button
    signoutBtn.onclick=function(){
      close();
      const real=$('.app-header #logout, .app-header .sign-out, .app-header .hdr-signout');
      if(real)real.click();
      else{
        fetch('/api/auth?action=logout',{method:'POST',credentials:'same-origin'})
          .finally(()=>{location.href='/login';});
      }
    };
  }

  function open(){
    const drawer=$('#nav-drawer');const btn=$('.hamburger');
    if(!drawer)return;
    sync();
    drawer.classList.add('open');
    if(btn)btn.setAttribute('aria-expanded','true');
    document.body.style.overflow='hidden';
  }
  function close(){
    const drawer=$('#nav-drawer');const btn=$('.hamburger');
    if(!drawer)return;
    drawer.classList.remove('open');
    if(btn)btn.setAttribute('aria-expanded','false');
    document.body.style.overflow='';
  }
  function toggle(){
    const drawer=$('#nav-drawer');
    if(!drawer)return;
    drawer.classList.contains('open')?close():open();
  }

  function init(){
    build();
    const btn=$('.hamburger'); if(btn)btn.addEventListener('click',toggle);
    const drawer=$('#nav-drawer');
    if(drawer)drawer.addEventListener('click',e=>{if(e.target===drawer)close();});
    document.addEventListener('keydown',e=>{if(e.key==='Escape')close();});
    // Keep drawer in sync if page updates role-gated pills after auth resolves
    const hdr=$('.app-header');
    if(hdr){
      const obs=new MutationObserver(()=>{ if($('#nav-drawer.open'))sync(); });
      obs.observe(hdr,{subtree:true,attributes:true,attributeFilter:['style','class']});
    }
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);
  else init();

  // Global toast helper — drop-in replacement for alert() calls
  // Usage: showToast('message'), showToast('message','error'|'success'|'warn', 4000)
  window.showToast = function(msg, kind, ms){
    if(!msg)return;
    let stack=document.getElementById('toast-stack');
    if(!stack){
      stack=document.createElement('div');
      stack.id='toast-stack';
      stack.className='toast-stack';
      document.body.appendChild(stack);
    }
    const el=document.createElement('div');
    el.className='toast'+(kind?' '+kind:'');
    el.textContent=String(msg);
    stack.appendChild(el);
    const life=ms||(kind==='error'?4200:2800);
    setTimeout(()=>{ el.style.transition='opacity .2s'; el.style.opacity='0'; setTimeout(()=>el.remove(),220); }, life);
  };
})();
