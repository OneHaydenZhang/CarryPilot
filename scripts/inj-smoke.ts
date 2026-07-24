import { IndexerGrpcDerivativesApi } from '@injectivelabs/sdk-ts';
import { getNetworkEndpoints, Network } from '@injectivelabs/networks';

const e = getNetworkEndpoints(Network.Mainnet);
console.log('indexer endpoint:', e.indexer);
try {
  const m = await new IndexerGrpcDerivativesApi(e.indexer).fetchMarkets();
  console.log('INJ markets OK:', m.length, m.slice(0, 3).map((x) => x.ticker));
} catch (err) {
  console.log('INJ ERR:', String(err).slice(0, 500));
}
