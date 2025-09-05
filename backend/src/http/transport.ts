import { Agent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(new Agent({
  keepAliveTimeout: 10_000,
  headersTimeout:   2_500,
  bodyTimeout:      4_000,
  pipelining:       1,
  maxRedirections:  0
}));


