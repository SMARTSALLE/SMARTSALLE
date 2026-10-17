const base='http://localhost:4599';
const fs=require('fs');
const cookie=fs.readFileSync('cj.txt','utf8').split('\n').filter(l=>l.includes('ss_session')).map(l=>l.trim().split('\t').slice(-2).join('=')).join('; ');
(async()=>{
  const r=await fetch(base+'/api/reservations',{headers:{cookie}});
  const j=await r.json();
  (j.reservations||[]).forEach(x=>console.log(x.id, x.semester, x.room_code, x.start+'-'+x.end));
})();
