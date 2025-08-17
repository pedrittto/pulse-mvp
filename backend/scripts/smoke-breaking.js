#!/usr/bin/env node

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

async function smokeTest() {
  console.log('🚀 Starting Breaking Mode Smoke Test...\n');

  try {
    // 1. Check health endpoint
    console.log('1. Checking /health endpoint...');
    const healthResponse = await fetch(`${BASE_URL}/health`);
    if (!healthResponse.ok) throw new Error(`HTTP ${healthResponse.status}`);
    const healthData = await healthResponse.json();
    console.log('✅ Health endpoint OK');
    console.log(`   Breaking mode: ${healthData.breaking.mode}`);
    console.log(`   Sources: ${healthData.breaking.sources.length}`);
    
    // 2. Force re-ingest for 2-3 sources
    console.log('\n2. Testing /admin/reingest...');
    const reingestResponse = await fetch(`${BASE_URL}/admin/reingest`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ADMIN_TOKEN}` 
      },
      body: JSON.stringify({
        sources: ['Bloomberg Breaking', 'CNBC Breaking'],
        force: true
      })
    });
    if (!reingestResponse.ok) throw new Error(`HTTP ${reingestResponse.status}`);
    const reingestData = await reingestResponse.json();
    console.log('✅ Re-ingest scheduled');
    console.log(`   Scheduled: ${reingestData.scheduled.join(', ')}`);
    
    // 3. Wait 60 seconds
    console.log('\n3. Waiting 60 seconds for aggregation...');
    await new Promise(resolve => setTimeout(resolve, 60000));
    
    // 4. Check health again for stats
    console.log('\n4. Checking aggregated stats...');
    const healthResponse2 = await fetch(`${BASE_URL}/health`);
    if (!healthResponse2.ok) throw new Error(`HTTP ${healthResponse2.status}`);
    const healthData2 = await healthResponse2.json();
    const sources = healthData2.breaking.sources;
    
    sources.forEach(source => {
      if (source.newInLast1m > 0 || source.duplicatesInLast1m > 0) {
        console.log(`   ${source.name}: new=${source.newInLast1m}, dupes=${source.duplicatesInLast1m}`);
      }
    });
    
    // 5. Reset breaking state
    console.log('\n5. Testing /admin/reset-breaking-state...');
    const resetResponse = await fetch(`${BASE_URL}/admin/reset-breaking-state`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ADMIN_TOKEN}` 
      },
      body: JSON.stringify({})
    });
    if (!resetResponse.ok) throw new Error(`HTTP ${resetResponse.status}`);
    console.log('✅ Breaking state reset');
    
    console.log('\n🎉 Smoke test completed successfully!');
    
  } catch (error) {
    console.error('\n❌ Smoke test failed:');
    console.error(`   Error: ${error.message}`);
    process.exit(1);
  }
}

// Run the smoke test
smokeTest();
