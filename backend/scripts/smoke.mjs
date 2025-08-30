import http from "node:http";
function get(path){
  return new Promise((resolve,reject)=>{
    const req = http.get(`http://localhost:4000${path}`, res=>{
      let data=""; res.on("data", c=>data+=c);
      res.on("end", ()=> resolve({status:res.statusCode, body:data}));
    });
    req.on("error", reject);
  });
}
const main = async () => {
  const h = await get("/health");
  const m = await get("/metrics-lite");
  console.log("HEALTH:", h.status, h.body);
  console.log("METRICS:", m.status, m.body);
  if (h.status !== 200) process.exit(1);
};
main();
