const http=require('http'); const p=process.env.PORT||4000;
http.get({host:'127.0.0.1',port:p,path:'/metrics-prom'}, r=>{let d=''; r.on('data',c=>d+=c); r.on('end',()=>console.log(d.split('\n').slice(0,60).join('\n')));});


