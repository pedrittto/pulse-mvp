import http from "node:http";
import https from "node:https";

export const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 12, maxFreeSockets: 6 });
export const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 12, maxFreeSockets: 6 });

export function pickAgent(url: string) {
  return url.startsWith("https:") ? httpsAgent : httpAgent;
}


