import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export const __filename = fileURLToPath(import.meta.url);
export const __dirname = path.dirname(__filename);
export const isMain = (u: string = import.meta.url) => u === pathToFileURL(process.argv[1]).href;


