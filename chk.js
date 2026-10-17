const base='http://localhost:4599';
const fs=require('fs');
const cookie=fs.readFileSync('cj.txt','utf8').split('\n').filter(l=>l.includes('ss_session')).map(l=>l.trim().split('\t').slice(-2).join('=')).join('; ');
(async()=>{
  for(const s of ['','S2','S3','S4','S5']){
    const u=base+'/api/reservations'+(s?('?semester='+encodeURIComponent(s)):'');
    const r=await fetch(u,{headers:{cookie}});
    const j=await r.json();
    const list=j.reservations||[];
    console.log((s||'TOUT').padEnd(5),'|',list.length,'|',list.map(x=>`${x.room_code} ${x.start}-${x.end}`).join(' , '));
  }
})();
