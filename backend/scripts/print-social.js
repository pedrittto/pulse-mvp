const http=require('http');
const p=process.env.PORT||4000;
http.get({host:'127.0.0.1',port:p,path:'/metrics-lite'},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{ try{const j=JSON.parse(d); console.log('SOCIAL', j.social||{});}catch{ console.log((d||'').slice(0,400)); } });});


