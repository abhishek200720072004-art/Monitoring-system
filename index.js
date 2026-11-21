import { CentralSaaSServer } from './tier2_saas/server.js';
import { LocalCollectorDaemon } from './tier1_collector/collector.js';

console.log('================================================================');
console.log('   CICADA 2026 - AIOPS OBSERVABILITY PLATFORM INITIALIZING      ');
console.log('   Two-Tier Architecture: Local-First Security + Metadata SaaS  ');
console.log('================================================================');

const PORT = process.env.PORT || 3000;
const REGION = process.env.REGION || 'ap-south-1';
const TENANT_ID = process.env.TENANT_ID || 'tenant-acme-prod';

// 1. Initialize Tier 2 SaaS Platform
const saasServer = new CentralSaaSServer(PORT, REGION);
saasServer.start();

// 2. Initialize Tier 1 Customer Local Collector Daemon
const collector = new LocalCollectorDaemon({
  collectorId: 'col-eu-01',
  tenantId: TENANT_ID,
  region: REGION,
  saasEndpoint: `http://localhost:${PORT}/api/v1/regional/${REGION}/ingest`,
  authToken: 'col_sec_token_cicada_99182a'
});

// Link collector reference to SaaS server for Chaos injection & Egress Proof verification
saasServer.setCollectorRef(collector);

// 3. Start collector processing
setTimeout(() => {
  collector.start();
  console.log('----------------------------------------------------------------');
  console.log(`🚀 Platform Online!`);
  console.log(`🌐 Open Dashboard: http://localhost:${PORT}`);
  console.log(`🔒 Tier 1 Local Collector: Running with local SQLite buffer`);
  console.log(`☁️  Tier 2 Central SaaS: Ingesting allow-listed metadata only`);
  console.log('----------------------------------------------------------------');
}, 1000);

// Graceful exit
process.on('SIGINT', () => {
  console.log('\nShutting down CICADA Observability Platform...');
  collector.stop();
  saasServer.stop();
  process.exit(0);
});
