const base='http://localhost:4599';
const fs=require('fs');
const cookie=fs.readFileSync('cj.txt','utf8').split('\n').filter(l=>l.includes('ss_session')).map(l=>l.trim().split('\t').slice(-2).join('=')).join('; ');
const mk=(room)=>({option_id:1,date:'2026-11-03',start:'08:00',end:'10:00',room_id:room,semester:'S5',group_id:1,teacher_id:1,title:'course simultanee'});
(async()=>{
  console.log('== Scenario 6 : deux POST simultanes sur S01, meme creneau ==');
  const [a,b]=await Promise.all([
    fetch(base+'/api/reservations',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify(mk(1))}),
    fetch(base+'/api/reservations',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify(mk(1))})
  ]);
  const ja=await a.json(), jb=await b.json();
  console.log('   A ->', a.status, ja.ok?'ACCEPTEE':(ja.error&&ja.error.code));
  console.log('   B ->', b.status, jb.ok?'ACCEPTEE':(jb.error&&jb.error.code));
  console.log((a.status===201)!==(b.status===201) ? '   PASS : une seule reservation acceptee' : '   FAIL');
  console.log('== Scenario 6 (suite) : deux comptes differents ==');
  // meme chose mais verifie que la course n'est pas cassee par un verrou trop tot
  const [c,d2]=await Promise.all([
    fetch(base+'/api/reservations',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({...mk(2), semester:'S6'})}),
    fetch(base+'/api/reservations',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({...mk(2), semester:'S6'})})
  ]);
  const jc=await c.json(), jd=await d2.json();
  console.log('   C ->', c.status, jc.ok?'ACCEPTEE':(jc.error&&jc.error.code));
  console.log('   D ->', d2.status, jd.ok?'ACCEPTEE':(jd.error&&jd.error.code));
  console.log((c.status===201)!==(d2.status===201) ? '   PASS : une seule reservation acceptee' : '   FAIL');
})();
