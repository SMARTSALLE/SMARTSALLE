const base='http://localhost:4599';
const fs=require('fs');
const cookie=fs.readFileSync('cj.txt','utf8').split('\n').filter(l=>l.includes('ss_session')).map(l=>l.trim().split('\t').slice(-2).join('=')).join('; ');
// sans enseignant, groupe 2 libre le 2026-11-04 : seul le verrou GROUPE départage
const mk=()=>({option_id:1,date:'2026-11-04',start:'08:00',end:'10:00',room_id:9,semester:'S5',group_id:2,title:'course simultanee'});
(async()=>{
  console.log('== Scenario 6b : deux POST simultanes, sans enseignant, meme GROUPE, salles differentes ==');
  const [a,b]=await Promise.all([
    fetch(base+'/api/reservations',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({...mk(),room_id:9})}),
    fetch(base+'/api/reservations',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({...mk(),room_id:10})})
  ]);
  const ja=await a.json(), jb=await b.json();
  console.log('   A (salle 9)  ->', a.status, ja.ok?'ACCEPTEE':(ja.error&&ja.error.code));
  console.log('   B (salle 10) ->', b.status, jb.ok?'ACCEPTEE':(jb.error&&jb.error.code));
  console.log((a.status===201)!==(b.status===201) ? '   PASS : une seule reservation acceptee' : '   FAIL : les deux ont passe');
})();
